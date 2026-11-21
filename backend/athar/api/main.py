"""Athar REST API.

    uvicorn athar.api.main:app --reload --port 8000
"""
from __future__ import annotations

import datetime as dt
import json
from functools import lru_cache
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .. import llm
from ..config import CACHE_DIR, DATA_DIR, OUTPUT_DIR, rules
from ..explain.explain import llm_summary
from ..extraction.llm_extractor import get_extractor
from ..pipeline import Athar, extract_all, load_records, load_truth
from ..schemas import Assessment, Category, PatientRecord
from ..agents import sceptic as sc

app = FastAPI(title="Athar API", version="0.1.0",
              description="Screening-support pattern detection for possible endometriosis. Not a diagnostic device.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ATHAR = Athar()
DATASETS = ("eval", "dev")


def _dataset_extractor(dataset: str) -> str:
    """Use cached LLM extractions when they exist, otherwise the keyword baseline."""
    return sc.dataset_extractor(dataset)


@lru_cache(maxsize=4)
def _dataset(dataset: str) -> dict:
    if dataset not in DATASETS or not (DATA_DIR / f"{dataset}_records.json").exists():
        raise HTTPException(404, f"dataset '{dataset}' not found; run python -m athar.generator.build")
    recs = load_records(dataset)
    exs = extract_all(recs, _dataset_extractor(dataset), dataset)
    sceptic = sc.load_results(dataset)
    out = {}
    for r in recs:
        a = ATHAR.assess(r, exs[r.patient_id])
        res = sceptic.get(r.patient_id)
        # only use a stored review if it was made on exactly this record, these findings and this outcome
        if res and (res.digest != sc.digest(r, exs[r.patient_id]) or res.original_category != a.category.value):
            res = None
        out[r.patient_id] = {"record": r, "assessment": sc.apply_to_assessment(a, res), "sceptic": res,
                             "findings": exs[r.patient_id].findings}
    return out


def _age(r: PatientRecord) -> Optional[int]:
    dates = [e.date for e in r.encounters if e.date and e.date <= dt.date.today()]
    return (max(dates).year - r.birth_year) if (dates and r.birth_year) else None


@app.get("/api/health")
def health():
    return {"status": "ok", "model_loaded": ATHAR.model is not None, "model": ATHAR.model.meta["chosen_model"] if ATHAR.model else None,
            "llm_available": llm.available(), "llm_model": llm.llm_model(),
            "extractor_by_dataset": {d: _dataset_extractor(d) for d in DATASETS}}


@app.get("/api/patients")
def list_patients(dataset: str = "eval", category: Optional[str] = None, q: Optional[str] = None):
    rows = []
    for pid, v in _dataset(dataset).items():
        a: Assessment = v["assessment"]; r: PatientRecord = v["record"]
        if category and a.category.name != category and a.category.value != category:
            continue
        if q and q.lower() not in pid.lower():
            continue
        dates = sorted(e.date for e in r.encounters if e.date)
        rows.append({
            "patient_id": pid, "age": _age(r), "n_encounters": len(r.encounters), "category": a.category.value, "category_key": a.category.name,
            "priority": a.priority, "model_score": a.model_score, "relevant_encounters": a.relevant_encounters,
            "first_date": dates[0] if dates else None, "last_date": dates[-1] if dates else None,
            "headline": a.reasons[-1] if a.reasons else "", "key_features": [c.label for c in a.contributors if c.direction == "raises" and c.value > 0][:3],
            "data_quality_issues": len(a.data_quality),
            "referred": bool(a.features.get("gyn_referral", 0) > 0),
            "sceptic_verdict": v["sceptic"].verdict if v["sceptic"] and v["sceptic"].ran else None,
        })
    # flags the sceptic upheld come first, then unreviewed, then flags it weakened or challenged
    vorder = {"upheld": 0, None: 1, "weakened": 2, "challenged": 3}
    rows.sort(key=lambda x: (vorder.get(x["sceptic_verdict"], 1), x["priority"], -(x["model_score"] or 0)))
    counts = {c.name: sum(1 for x in rows if x["category_key"] == c.name) for c in Category}
    return {"dataset": dataset, "extractor": _dataset_extractor(dataset), "counts": counts, "patients": rows}


@app.get("/api/patients/{patient_id}")
def get_patient(patient_id: str, dataset: str = "eval", include_truth: bool = False):
    d = _dataset(dataset)
    if patient_id not in d:
        raise HTTPException(404, "patient not found")
    out = {"record": d[patient_id]["record"], "assessment": d[patient_id]["assessment"], "sceptic": d[patient_id]["sceptic"],
           "n_findings": len(d[patient_id]["findings"]), "decision": _decisions().get(f"{dataset}:{patient_id}")}
    if include_truth:  # synthetic ground truth, for demos/evaluation only
        t = load_truth(dataset).get(patient_id)
        out["synthetic_truth"] = {k: t[k] for k in ("endometriosis", "scenario_name", "subtype", "expected_category")} if t else None
    return out


@app.post("/api/patients/{patient_id}/summary")
def patient_summary(patient_id: str, dataset: str = "eval"):
    d = _dataset(dataset)
    if patient_id not in d:
        raise HTTPException(404, "patient not found")
    if not llm.available():
        raise HTTPException(503, "OPENROUTER_API_KEY not configured; template summary is shown instead")
    a = llm_summary(d[patient_id]["assessment"].model_copy(deep=True))
    d[patient_id]["assessment"] = a
    return {"summary": a.summary, "source": a.summary_source}


class AssessRequest(BaseModel):
    record: PatientRecord
    extractor: Literal["auto", "lexicon", "llm"] = "auto"
    llm_summary: bool = False


@app.post("/api/assess", response_model=Assessment)
def assess(req: AssessRequest):
    """Assess any patient record in the PatientRecord format (e.g. from Athar's main application)."""
    ex = get_extractor(req.extractor).extract(req.record)
    return ATHAR.assess(req.record, ex, with_llm_summary=req.llm_summary)


@app.get("/api/evaluation")
def evaluation():
    p = OUTPUT_DIR / "evaluation_report.json"
    if not p.exists():
        raise HTTPException(404, "run python -m athar.evaluation.evaluate first")
    return json.loads(p.read_text(encoding="utf-8"))


@app.get("/api/model")
def model_meta():
    from ..temporal.features import FEATURE_LABELS
    if not ATHAR.model:
        return {"error": "no model trained"}
    return {**ATHAR.model.meta, "feature_labels": {f: FEATURE_LABELS.get(f, f) for f in ATHAR.model.meta["features"]}}


@app.get("/api/rules")
def get_rules():
    return rules()


# ------------------------------------------------------------------ doctor's decision

def _decisions() -> dict:
    p = OUTPUT_DIR / "decisions.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


class DecisionRequest(BaseModel):
    decision: Literal["agree", "dismiss", "more_info"]
    note: str = ""


@app.post("/api/patients/{patient_id}/decision")
def record_decision(patient_id: str, req: DecisionRequest, dataset: str = "eval"):
    if patient_id not in _dataset(dataset):
        raise HTTPException(404, "patient not found")
    if req.decision == "dismiss" and not req.note.strip():
        raise HTTPException(422, "Please give a reason when dismissing a flag.")
    d = _decisions()
    d[f"{dataset}:{patient_id}"] = {"decision": req.decision, "note": req.note.strip()[:1000], "at": dt.datetime.now().isoformat(timespec="minutes")}
    (OUTPUT_DIR / "decisions.json").write_text(json.dumps(d, indent=1), encoding="utf-8")
    return d[f"{dataset}:{patient_id}"]


@app.get("/api/overview")
def overview(dataset: str = "eval"):
    pts = list_patients(dataset)
    return {"counts": pts["counts"], "total": len(pts["patients"]),
            "review_first": [p for p in pts["patients"] if p["category_key"] == "review" and p["priority"] == 1][:6]}
