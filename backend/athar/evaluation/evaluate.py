"""Evaluate Athar on the held-out synthetic evaluation set.

    python -m athar.evaluation.evaluate [--extractor lexicon|llm|auto] [--compare]

Two different questions are reported separately, on purpose:
  A. Constructed-scenario agreement: did Athar find the documented patterns we deliberately built?
  B. Hidden-label agreement: how often does a flag coincide with the synthetic 'endometriosis' label?
Neither demonstrates real-world clinical accuracy (synthetic data, no external validation).
"""
from __future__ import annotations

import argparse
import json
from collections import Counter

from sklearn.metrics import roc_auc_score

from ..config import OUTPUT_DIR
from ..pipeline import Athar, extract_all, load_records, load_truth
from ..schemas import Category

CATS = [Category.review.value, Category.insufficient.value, Category.no_pattern.value]
CAVEAT = ("These results measure performance on synthetic data generated for development. They show that the pipeline "
          "behaves as designed on constructed scenarios; they do NOT demonstrate clinical accuracy. Real-world performance "
          "requires real, labelled, de-identified records and external validation.")


def binary(y_true: list[int], y_pred: list[int]) -> dict:
    tp = sum(1 for t, p in zip(y_true, y_pred) if t and p)
    tn = sum(1 for t, p in zip(y_true, y_pred) if not t and not p)
    fp = sum(1 for t, p in zip(y_true, y_pred) if not t and p)
    fn = sum(1 for t, p in zip(y_true, y_pred) if t and not p)
    sens = tp / (tp + fn) if tp + fn else None
    spec = tn / (tn + fp) if tn + fp else None
    prec = tp / (tp + fp) if tp + fp else None
    f1 = 2 * prec * sens / (prec + sens) if prec and sens else 0.0
    r = lambda x: round(x, 3) if x is not None else None
    return {"n": len(y_true), "tp": tp, "fp": fp, "tn": tn, "fn": fn, "sensitivity": r(sens), "specificity": r(spec), "precision": r(prec),
            "f1": r(f1), "false_positive_rate": r(1 - spec) if spec is not None else None, "false_negative_rate": r(1 - sens) if sens is not None else None}


def extraction_quality(records, exs, truth) -> dict:
    tp = fp = fn = st_ok = st_n = ln_ok = ln_n = 0
    for r in records:
        res = exs[r.patient_id]
        skip = {i.encounter_id for i in res.issues if i.kind == "duplicate_encounter"}
        pred = {(f.encounter_id, f.concept): f for f in res.findings if f.category == "symptom"}
        gold = {(e["encounter_id"], s["concept"]): s for e in truth[r.patient_id]["encounters"] if e["encounter_id"] not in skip for s in e["symptoms"]}
        for k, g in gold.items():
            if k in pred:
                tp += 1
                st_n += 1; st_ok += pred[k].status.value == g["status"]
                if g["status"] == "present" and g["concept"] != "dysmenorrhoea":
                    ln_n += 1; ln_ok += pred[k].menstrual_link.value == g["menstrual_link"]
            else:
                fn += 1
        fp += sum(1 for k in pred if k not in gold)
    return {"symptom_precision": round(tp / max(1, tp + fp), 3), "symptom_recall": round(tp / max(1, tp + fn), 3),
            "status_accuracy_when_found": round(st_ok / max(1, st_n), 3), "menstrual_link_accuracy_when_found": round(ln_ok / max(1, ln_n), 3),
            "note": "Present/absent/uncertain status and menstrual link scored against the generator's ground truth, per encounter."}


def _roc(y: list[int], p: list[float]) -> list[list[float]]:
    from sklearn.metrics import roc_curve
    if len(set(y)) < 2:
        return []
    fpr, tpr, _ = roc_curve(y, p)
    return [[round(float(a), 3), round(float(b), 3)] for a, b in zip(fpr, tpr)]


def _threshold_curve(extractor: str, ath: Athar) -> dict | None:
    """Out-of-fold sensitivity and specificity on the development set at every threshold, as used to pick the operating point."""
    import numpy as np
    from sklearn.model_selection import StratifiedKFold, cross_val_predict
    from ..model.model import candidates, to_matrix
    from ..temporal.features import compute_features
    if not ath.model:
        return None
    try:
        recs, truth = load_records("dev"), load_truth("dev")
        exs = extract_all(recs, extractor, "dev")
    except BaseException:
        return None
    X = to_matrix([compute_features(r, exs[r.patient_id]).values for r in recs])
    y = np.array([int(truth[r.patient_id]["endometriosis"]) for r in recs])
    p = cross_val_predict(candidates()[ath.model.meta["chosen_model"]], X, y, cv=StratifiedKFold(5, shuffle=True, random_state=0), method="predict_proba")[:, 1]
    pts = []
    for t in np.round(np.arange(0.02, 1.0, 0.02), 2):
        sens = float(((p >= t) & (y == 1)).sum() / max(1, (y == 1).sum()))
        spec = float(((p < t) & (y == 0)).sum() / max(1, (y == 0).sum()))
        pts.append({"t": float(t), "sensitivity": round(sens, 3), "specificity": round(spec, 3)})
    # exact figures at the chosen threshold (the 0.02 grid alone would report the nearest grid point instead)
    thr = float(ath.model.meta["threshold"])
    at = {"t": thr, "sensitivity": round(float(((p >= thr) & (y == 1)).sum() / max(1, (y == 1).sum())), 3),
          "specificity": round(float(((p < thr) & (y == 0)).sum() / max(1, (y == 0).sum())), 3)}
    pts = sorted([q for q in pts if abs(q["t"] - thr) > 1e-9] + [at], key=lambda q: q["t"])
    return {"points": pts, "chosen": thr, "at_chosen": at, "rule": ath.model.meta["threshold_rule"], "n_dev": int(len(y))}


RULE_BASELINES = {
    "rule_a": {
        "name": "Guideline rule A",
        "definition": ">=2 separate visits with relevant pain AND >=1 strong symptom domain "
                      "(painful periods, pelvic pain, pain with sex or painful bowel movements).",
        "fn": lambda v: v["n_relevant_encounters"] >= 2 and v["n_strong_domains"] >= 1,
    },
    "rule_b": {
        "name": "Guideline rule B",
        "definition": "Rule A AND at least one of: non-period pain explicitly linked to the cycle, pain persisting >=8 weeks "
                      "after a pain treatment was started, or pain documented after a normal investigation.",
        "fn": lambda v: (v["n_relevant_encounters"] >= 2 and v["n_strong_domains"] >= 1
                         and (v["n_cyclical_nonmenstrual"] >= 1 or v["persist_after_treatment"] or v["persist_after_normal_investigation"])),
    },
}
BOOT_N, BOOT_SEED = 1000, 20260101
CI_METRICS = ("sensitivity", "specificity", "precision", "flagged", "false_positives")
COUNT_METRICS = ("flagged", "false_positives")


def _vec_metrics(y, p) -> dict:
    """Metrics for many bootstrap samples at once: y, p are (resamples, n) 0/1 arrays. Undefined ratios are NaN."""
    import numpy as np
    tp = (y & p).sum(1); fp = (~y & p).sum(1); fn = (y & ~p).sum(1); tn = (~y & ~p).sum(1)
    div = lambda a, b: np.where(b > 0, a / np.maximum(b, 1), np.nan)
    return {"sensitivity": div(tp, tp + fn), "specificity": div(tn, tn + fp), "precision": div(tp, tp + fp),
            "flagged": (tp + fp).astype(float), "false_positives": fp.astype(float)}


def _ci(samples, counts: bool = False) -> list[float]:
    import numpy as np
    s = np.asarray(samples, float)
    s = s[~np.isnan(s)]
    if not len(s):
        return [None, None]
    lo, hi = np.percentile(s, 2.5), np.percentile(s, 97.5)
    return [int(np.floor(lo)), int(np.ceil(hi))] if counts else [round(float(lo), 3), round(float(hi), 3)]


def rule_baselines(rows: list[dict], n_boot: int = BOOT_N, seed: int = BOOT_SEED) -> dict:
    """Athar vs guideline-only rules on the same extracted features, against the hidden label, with paired bootstrap CIs.

    Patients are resampled with replacement; every method is scored on the same resamples, so the differences are paired.
    """
    import numpy as np
    y = np.array([x["label"] for x in rows], bool)
    preds = {"athar": np.array([x["cat"] == Category.review.value for x in rows], bool)}
    for k, rb in RULE_BASELINES.items():
        preds[k] = np.array([bool(rb["fn"](x["features"])) for x in rows], bool)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(rows), size=(n_boot, len(rows)))
    boot = {k: _vec_metrics(y[idx], p[idx]) for k, p in preds.items()}
    point = {k: _vec_metrics(y[None, :], p[None, :]) for k, p in preds.items()}
    r3 = lambda a, m="": None if np.isnan(a) else (int(a) if m in COUNT_METRICS else round(float(a), 3))

    methods = {}
    for k in preds:
        b = binary(y.astype(int).tolist(), preds[k].astype(int).tolist())
        methods[k] = {"name": RULE_BASELINES[k]["name"] if k in RULE_BASELINES else "Athar",
                      "definition": RULE_BASELINES[k]["definition"] if k in RULE_BASELINES else
                      "Final Athar output (PATTERN WARRANTS CLINICAL REVIEW) as reported in section B.",
                      "tp": b["tp"], "fp": b["fp"], "tn": b["tn"], "fn": b["fn"],
                      **{m: {"value": r3(point[k][m][0], m), "ci95": _ci(boot[k][m], m in COUNT_METRICS)} for m in CI_METRICS}}
    diffs = {k: {m: {"value": r3(point["athar"][m][0] - point[k][m][0], m), "ci95": _ci(boot["athar"][m] - boot[k][m], m in COUNT_METRICS)} for m in CI_METRICS}
             for k in RULE_BASELINES}

    # Athar model-score ROC-AUC with a bootstrap CI (resamples containing only one class are skipped)
    scored = [i for i, x in enumerate(rows) if x["score"] is not None]
    auc = None
    if scored:
        ys = y[scored].astype(int); ss = np.array([rows[i]["score"] for i in scored], float)
        aucs = [roc_auc_score(ys[j], ss[j]) for j in np.random.default_rng(seed + 1).integers(0, len(scored), size=(n_boot, len(scored)))
                if 0 < ys[j].sum() < len(j)]
        auc = {"value": round(float(roc_auc_score(ys, ss)), 3), "ci95": _ci(aucs), "valid_resamples": len(aucs), "n": len(scored)}
    return {
        "description": "Guideline-only rules applied to the SAME extracted features Athar uses "
                       "(no model, no LLM at decision time), scored against the hidden synthetic label. INSUFFICIENT counts as not flagged.",
        "bootstrap": {"resamples": n_boot, "seed": seed, "method": "percentile 95% CI; patients resampled with replacement; "
                      "all methods scored on the same resamples (paired), so differences have their own CI"},
        "n": len(rows), "label_positive": int(y.sum()),
        "methods": methods, "athar_minus_rule": diffs, "athar_auc": auc,
        "note": "Rules give yes/no flags, so they have no ROC-AUC. A difference whose CI excludes 0 is unlikely to be bootstrap noise "
                "on this synthetic set; it is still not evidence about real patients.",
    }


def _why_not_flagged(x: dict, d: dict) -> list[str]:
    """Plain-language reason(s) a patient was not flagged, read from the decision trail."""
    if x["sceptic_changed"] and x["cat_raw"] == Category.review.value:
        return ["Downgraded by the sceptic reviewer"]
    if x["cat"] == Category.insufficient.value:
        r = (d["reasons"] or [""])[0]
        if r.startswith("Only"):
            return ["Too few documented visits (needs more history)"]
        if r.startswith("Relevant pain appears in a single"):
            return ["Pain at a single visit in a short record (needs more history)"]
        if r.startswith("Pain is mentioned but"):
            return ["Pain without timing, severity or treatment recorded (needs more history)"]
        return ["Needs more history"]
    out = []
    for g in d["guardrails"]:
        if "relevant pain documented in" in g:
            out.append("Guardrail: pain at fewer than 2 visits")
        elif "only nonspecific symptoms" in g:
            out.append("Guardrail: only nonspecific symptoms")
        elif "alternative diagnosis" in g:
            out.append("Guardrail: another diagnosis explains the symptoms")
        else:
            out.append("Guardrail: other")
    return out or ["Model score below the threshold"]


def _score_band(score: float | None, thr: float) -> str:
    if score is None:
        return "No score"
    if score >= thr:
        return "At or above the threshold"
    return "Close: at least half the threshold" if score >= thr / 2 else "Low: under half the threshold"


def _pattern_gaps(v: dict) -> list[str]:
    """Which parts of the guideline pattern the extracted record does not show."""
    gaps = []
    if v.get("n_relevant_encounters", 0) < 2:
        gaps.append("Relevant pain recorded at fewer than 2 visits")
    if v.get("n_strong_domains", 0) == 0:
        gaps.append("No key symptom (painful periods, pelvic pain, pain with sex, painful bowel movements)")
    if v.get("n_cyclical_nonmenstrual", 0) == 0:
        gaps.append("Pain never recorded as following the cycle")
    if v.get("n_explicit_noncyclical", 0) > 0:
        gaps.append("Pain explicitly recorded as not period-related")
    if not v.get("persist_after_treatment") and not v.get("persist_after_normal_investigation"):
        gaps.append("No pain recorded as persisting after treatment or a normal test")
    if v.get("alt_explains_all"):
        gaps.append("Another recorded diagnosis accounts for the symptoms")
    if v.get("documentation_completeness", 0) < 1 / 3 and v.get("n_relevant_encounters", 0) > 0:
        gaps.append("Pain visits rarely record cycle link, severity or treatment response")
    return gaps


def misses_analysis(rows: list[dict], detail: dict, threshold: float) -> dict:
    """Hidden-label positives that were not flagged, split into cases built with no visible pattern vs genuine misses."""
    missed = [x for x in rows if x["label"] and x["cat"] != Category.review.value]
    built_invisible = [x for x in missed if x["expected"] != Category.review.value]
    genuine = [x for x in missed if x["expected"] == Category.review.value]

    def summary(rs):
        why = Counter(w for x in rs for w in _why_not_flagged(x, detail[x["id"]]))
        scores = sorted(x["score"] for x in rs if x["score"] is not None)
        return {"n": len(rs),
                "by_scenario": dict(Counter(f"{x['scenario']} / {x['subtype']}" for x in rs).most_common()),
                "by_category": dict(Counter(x["cat"] for x in rs).most_common()),
                "by_reason": dict(why.most_common()),
                "by_score_band": dict(Counter(_score_band(x["score"], threshold) for x in rs).most_common()),
                "median_score": round(scores[len(scores) // 2], 3) if scores else None}

    cases = []
    for x in sorted(genuine, key=lambda x: -(x["score"] or 0)):
        d = detail[x["id"]]
        cases.append({"id": x["id"], "scenario": x["scenario"], "subtype": x["subtype"], "category": x["cat"],
                      "why_not_flagged": _why_not_flagged(x, d), "score": x["score"], "score_band": _score_band(x["score"], threshold),
                      "relevant_visits": x["relevant"], "pattern_gaps": _pattern_gaps(d["features"]),
                      "model_lowered_by": [lbl for _, lbl in d["lowers"][:3]], "record_gaps": d["missing"][:4]})
    return {
        "description": "Patients with the hidden synthetic label whose final category was not PATTERN WARRANTS CLINICAL REVIEW.",
        "threshold": threshold, "label_positive": sum(x["label"] for x in rows), "missed": len(missed),
        "built_without_visible_pattern": {
            "definition": "Label positive but built to show something other than a reviewable pattern (expected category is not REVIEW): "
                          "silent records, isolated symptoms, sparse records, period pain only. No record-based tool can be expected to flag these.",
            **summary(built_invisible)},
        "genuine_misses": {
            "definition": "Label positive and built to show a reviewable pattern in the notes, but not flagged.",
            **summary(genuine),
            "common_pattern_gaps": dict(Counter(gp for c in cases for gp in c["pattern_gaps"]).most_common()),
            "cases": cases},
    }


def _documentation_groups(rows: list[dict]) -> dict:
    flag = lambda rs: [int(x["cat"] == Category.review.value) for x in rs]
    def grp(rs):
        return {"n": len(rs), "label_positive": sum(x["label"] for x in rs), **{k: binary([x["label"] for x in rs], flag(rs))[k] for k in ("sensitivity", "specificity")}}
    with_pain = [x for x in rows if x["relevant"] > 0]
    return {
        "by_record_length": {
            "1 to 3 documented visits": grp([x for x in rows if x["content_visits"] <= 3]),
            "4 to 7 documented visits": grp([x for x in rows if 4 <= x["content_visits"] <= 7]),
            "8 or more documented visits": grp([x for x in rows if x["content_visits"] >= 8]),
        },
        "by_note_completeness": {
            "Rarely recorded (under a third)": grp([x for x in with_pain if x["doc_completeness"] < 1 / 3]),
            "Sometimes recorded": grp([x for x in with_pain if 1 / 3 <= x["doc_completeness"] < 2 / 3]),
            "Usually recorded (two thirds or more)": grp([x for x in with_pain if x["doc_completeness"] >= 2 / 3]),
        },
        "note": "Note completeness = share of pain visits whose note records the link to periods, the severity or the response to treatment. "
                "Only patients with at least one relevant pain visit are grouped by completeness.",
    }


def evaluate(extractor: str = "auto") -> dict:
    recs, truth = load_records("eval"), load_truth("eval")
    exs = extract_all(recs, extractor, "eval")
    ath = Athar()
    from ..agents import sceptic as sc
    sceptic = sc.load_results("eval")
    rows, detail = [], {}
    for r in recs:
        a = ath.assess(r, exs[r.patient_id])
        t = truth[r.patient_id]
        res = sceptic.get(r.patient_id)
        if res and (res.digest != sc.digest(r, exs[r.patient_id]) or res.original_category != a.category.value):
            res = None
        rows.append({"id": r.patient_id, "cat": a.category.value, "cat_raw": a.category.value,
                     "cat_sceptic": sc.apply_to_assessment(a, res).category.value, "sceptic_ran": bool(res and res.ran),
                     "sceptic_changed": bool(res and res.changed), "sceptic_verdict": res.verdict if res and res.ran else None,
                     "doc_completeness": a.features.get("documentation_completeness", 0.0), "content_visits": a.features.get("n_content_encounters", 0.0),
                     "relevant": a.relevant_encounters, "score": a.model_score, "label": int(t["endometriosis"]),
                     "expected": t["expected_category"], "scenario": t["scenario_name"], "subtype": t["subtype"],
                     "quality_issues": len([i for i in a.data_quality if i.kind != "unverified_quote"]),
                     "features": {k: a.features.get(k, 0.0) for k in ("n_relevant_encounters", "n_strong_domains", "n_cyclical_nonmenstrual",
                                                                       "persist_after_treatment", "persist_after_normal_investigation")}})
        if t["endometriosis"]:  # kept apart from rows so errors_sample stays compact
            detail[r.patient_id] = {"features": dict(a.features), "reasons": a.reasons, "guardrails": a.guardrails_applied, "missing": a.missing_or_uncertain,
                                    "lowers": [(c.feature, f"{c.label.split(' — ')[0]} ({c.value:g})") for c in a.contributors if c.direction == "lowers"]}
    flagged_raw = [x for x in rows if x["cat_raw"] == Category.review.value]
    coverage = sum(x["sceptic_ran"] for x in flagged_raw) / max(1, len(flagged_raw))
    use_sceptic = coverage == 1.0 and len(flagged_raw) > 0
    if use_sceptic:
        for x in rows:
            x["cat"] = x["cat_sceptic"]
    flag = lambda rs: [int(x["cat"] == Category.review.value) for x in rs]
    flag_by = lambda rs, k: [int(x[k] == Category.review.value) for x in rs]
    conf3 = {e: {p: sum(1 for x in rows if x["expected"] == e and x["cat"] == p) for p in CATS} for e in CATS}
    acc3 = sum(conf3[c][c] for c in CATS) / len(rows)
    scored = [x for x in rows if x["score"] is not None]
    report = {
        "caveat": CAVEAT, "extractor": next(iter(exs.values())).extractor, "model": ath.model.meta if ath.model else None,
        "n_patients": len(rows), "category_counts": dict(Counter(x["cat"] for x in rows)),
        "A_constructed_scenarios": {
            "description": "Athar's category vs the category the scenario was built to show (documented pattern, not diagnosis).",
            "confusion_matrix_expected_rows_predicted_cols": conf3, "three_class_accuracy": round(acc3, 3),
            "review_vs_not": binary([int(x["expected"] == Category.review.value) for x in rows], flag(rows)),
            "insufficient_detection": binary([int(x["expected"] == Category.insufficient.value) for x in rows],
                                             [int(x["cat"] == Category.insufficient.value) for x in rows]),
        },
        "B_hidden_label": {
            "description": "Flag (PATTERN WARRANTS CLINICAL REVIEW) vs the synthetic hidden endometriosis label. INSUFFICIENT counts as not flagged.",
            "all_patients": binary([x["label"] for x in rows], flag(rows)),
            "model_score_auc": round(roc_auc_score([x["label"] for x in scored], [x["score"] for x in scored]), 3) if scored else None,
        },
        "pipeline": "LLM reader + model + rules + sceptic reviewer" if use_sceptic else "LLM reader + model + rules (sceptic not run on every flag)",
        "sceptic": {
            "coverage": round(coverage, 3), "flags_reviewed": sum(x["sceptic_ran"] for x in flagged_raw), "flags_total": len(flagged_raw),
            "downgraded": sum(x["sceptic_changed"] for x in rows),
            "downgraded_label_negative": sum(1 for x in rows if x["sceptic_changed"] and not x["label"]),
            "downgraded_label_positive": sum(1 for x in rows if x["sceptic_changed"] and x["label"]),
            "without": {"vs_label": binary([x["label"] for x in rows], flag_by(rows, "cat_raw")),
                        "vs_constructed": binary([int(x["expected"] == Category.review.value) for x in rows], flag_by(rows, "cat_raw"))},
            "with": {"vs_label": binary([x["label"] for x in rows], flag_by(rows, "cat_sceptic")),
                     "vs_constructed": binary([int(x["expected"] == Category.review.value) for x in rows], flag_by(rows, "cat_sceptic"))},
            "note": "Both rows use the same 200 patients and the same extraction; only the sceptic step differs.",
            "by_verdict": {v: {"n": sum(1 for x in rows if x["sceptic_verdict"] == v),
                               "label_positive": sum(1 for x in rows if x["sceptic_verdict"] == v and x["label"])}
                           for v in ("upheld", "weakened", "challenged")},
        },
        "C_rule_baselines": rule_baselines(rows),
        "D_misses": misses_analysis(rows, detail, ath.threshold),
        "documentation": _documentation_groups(rows),
        "roc_eval": _roc([x["label"] for x in scored], [x["score"] for x in scored]),
        "threshold_curve": _threshold_curve(extractor, ath),
        "subgroups": {},
        "extraction_quality": extraction_quality(recs, exs, truth),
    }
    groups = {
        "incomplete_records": lambda x: x["scenario"] == "insufficient_records" or x["quality_issues"] > 0,
        "alternative_condition_scenarios": lambda x: x["scenario"] in ("gi_non_menstrual", "overlapping_conditions", "pelvic_pain_no_menstrual_link"),
        "varied_terminology": lambda x: x["scenario"] == "varied_terminology",
        "inconsistent_documentation": lambda x: x["scenario"] == "inconsistent_documentation",
        "silent_positives_and_routine": lambda x: x["scenario"] == "routine_unrelated",
    }
    for g, fn in groups.items():
        rs = [x for x in rows if fn(x)]
        report["subgroups"][g] = {
            "n": len(rs), "categories": dict(Counter(x["cat"] for x in rs)),
            "vs_constructed": binary([int(x["expected"] == Category.review.value) for x in rs], flag(rs)),
            "vs_hidden_label": binary([x["label"] for x in rs], flag(rs)),
        }
    report["errors_sample"] = {
        "false_negatives_vs_label": [x for x in rows if x["label"] and x["cat"] != Category.review.value][:15],
        "false_positives_vs_label": [x for x in rows if not x["label"] and x["cat"] == Category.review.value][:15],
    }
    return report


def to_markdown(rep: dict) -> str:
    A, B = rep["A_constructed_scenarios"], rep["B_hidden_label"]
    m = rep.get("model") or {}
    L = ["# Athar evaluation report (synthetic held-out set)", "", f"> {rep['caveat']}", "",
         f"Extractor: `{rep['extractor']}` · Model: `{m.get('chosen_model')}` (threshold {m.get('threshold')}, {m.get('threshold_rule', '')}) · Patients: {rep['n_patients']}", "",
         "## Model comparison (5-fold CV on development set)", "", "| Model | CV ROC-AUC | CV avg precision |", "|---|---|---|"]
    for k, v in (m.get("candidates") or {}).items():
        L.append(f"| {k} | {v['cv_auc']} | {v['cv_average_precision']} |")
    L += ["", "## A. Constructed-scenario agreement", "", "Rows = category the scenario was built to show; columns = Athar's output.", "",
          "| expected \\ predicted | REVIEW | INSUFFICIENT | NO PATTERN |", "|---|---|---|---|"]
    short = {CATS[0]: "REVIEW", CATS[1]: "INSUFFICIENT", CATS[2]: "NO PATTERN"}
    for e in CATS:
        L.append(f"| {short[e]} | " + " | ".join(str(A["confusion_matrix_expected_rows_predicted_cols"][e][p]) for p in CATS) + " |")
    L += ["", f"Three-class accuracy: **{A['three_class_accuracy']}**", ""]

    def tbl(title, d):
        return [f"**{title}** — sensitivity {d['sensitivity']}, specificity {d['specificity']}, precision {d['precision']}, F1 {d['f1']}, "
                f"FPR {d['false_positive_rate']}, FNR {d['false_negative_rate']} (TP {d['tp']}, FP {d['fp']}, TN {d['tn']}, FN {d['fn']})", ""]
    L += tbl("Review vs not (constructed)", A["review_vs_not"])
    L += tbl("Insufficient-information detection", A["insufficient_detection"])
    L += ["## B. Agreement with the hidden synthetic label", ""] + tbl("Flag vs hidden label", B["all_patients"])
    L += [f"Model-score ROC-AUC on the evaluation set: **{B['model_score_auc']}** (published symptom-based models: ~0.65–0.85).", ""]
    C = rep.get("C_rule_baselines")
    if C:
        bs = C["bootstrap"]
        fmt = lambda d: (f"{d['value']}" if d["value"] is not None else "–") + (f" ({d['ci95'][0]} to {d['ci95'][1]})" if d["ci95"][0] is not None else "")
        L += ["## C. Does the AI beat simple rules?", "", C["description"], "",
              f"95% CIs from {bs['resamples']} paired bootstrap resamples of patients (seed {bs['seed']}). "
              f"{C['n']} patients, {C['label_positive']} with the hidden label.", ""]
        for k, d in C["methods"].items():
            if k != "athar":
                L.append(f"- **{d['name']}**: {d['definition']}")
        L += ["", "| Method | Sensitivity | Specificity | Precision | Flagged | False positives |", "|---|---|---|---|---|---|"]
        for k, d in C["methods"].items():
            L.append(f"| {d['name']} | " + " | ".join(fmt(d[m]) for m in CI_METRICS) + " |")
        L += ["", "Athar minus rule (paired bootstrap):", "", "| Comparison | Sensitivity | Specificity | Precision | Flagged | False positives |", "|---|---|---|---|---|---|"]
        for k, d in C["athar_minus_rule"].items():
            L.append(f"| Athar minus {C['methods'][k]['name']} | " + " | ".join(fmt(d[m]) for m in CI_METRICS) + " |")
        if C.get("athar_auc"):
            L += ["", f"Athar model-score ROC-AUC: **{fmt(C['athar_auc'])}** (n={C['athar_auc']['n']})."]
        L += ["", C["note"], ""]
    Dm = rep.get("D_misses")
    if Dm:
        bi, gm = Dm["built_without_visible_pattern"], Dm["genuine_misses"]
        cnt = lambda d: ", ".join(f"{k} ({v})" for k, v in d.items()) or "none"
        L += ["## D. What Athar misses, and why", "", f"{Dm['missed']} of {Dm['label_positive']} label-positive patients were not flagged "
              f"(threshold {Dm['threshold']}).", "",
              f"**Built without a visible pattern: {bi['n']}.** {bi['definition']}", "",
              f"- Scenario / subtype: {cnt(bi['by_scenario'])}", f"- Final category: {cnt(bi['by_category'])}",
              f"- Why not flagged: {cnt(bi['by_reason'])}", f"- Model score: {cnt(bi['by_score_band'])}; median {bi['median_score']}", "",
              f"**Genuine misses: {gm['n']}.** {gm['definition']}", "",
              f"- Scenario / subtype: {cnt(gm['by_scenario'])}", f"- Why not flagged: {cnt(gm['by_reason'])}",
              f"- Model score: {cnt(gm['by_score_band'])}; median {gm['median_score']}", f"- Most common pattern gaps: {cnt(gm['common_pattern_gaps'])}", ""]
        if gm["cases"]:
            L += ["| Patient | Scenario / subtype | Outcome | Why not flagged | Score | Main missing features |", "|---|---|---|---|---|---|"]
            for c in gm["cases"]:
                L.append(f"| {c['id']} | {c['scenario']} / {c['subtype']} | {c['category']} | {'; '.join(c['why_not_flagged'])} | {c['score']} | "
                         + "; ".join(c["pattern_gaps"] + [f"model lowered by: {', '.join(c['model_lowered_by'])}"] + c["record_gaps"]) + " |")
            L.append("")
        L += ["A record-based tool cannot find patients whose records are silent; a patient self-check route is planned for them.", ""]
    L += ["## Subgroups", "", "| Subgroup | n | sens (constructed) | spec (constructed) | sens (label) | spec (label) |", "|---|---|---|---|---|---|"]
    for g, d in rep["subgroups"].items():
        c, h = d["vs_constructed"], d["vs_hidden_label"]
        L.append(f"| {g} | {d['n']} | {c['sensitivity']} | {c['specificity']} | {h['sensitivity']} | {h['specificity']} |")
    e = rep["extraction_quality"]
    L += ["", "## Extraction quality (vs generator ground truth)", "",
          f"Symptom precision {e['symptom_precision']}, recall {e['symptom_recall']}, status accuracy {e['status_accuracy_when_found']}, "
          f"menstrual-link accuracy {e['menstrual_link_accuracy_when_found']}."]
    if "extractor_comparison" in rep:
        L += ["", "## LLM vs keyword extractor", "", "| Extractor | symptom recall | precision | flag sensitivity (label) | specificity (label) |", "|---|---|---|---|---|"]
        for k, v in rep["extractor_comparison"].items():
            L.append(f"| {k} | {v['symptom_recall']} | {v['symptom_precision']} | {v['sensitivity']} | {v['specificity']} |")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extractor", default="auto", choices=["auto", "lexicon", "llm"])
    ap.add_argument("--compare", action="store_true", help="also evaluate the other extractor (needs both)")
    a = ap.parse_args()
    rep = evaluate(a.extractor)
    if a.compare:
        comp = {}
        for name in ("lexicon", "llm"):
            try:
                r = evaluate(name)
                comp[r["extractor"]] = {**r["extraction_quality"], **{k: r["B_hidden_label"]["all_patients"][k] for k in ("sensitivity", "specificity")}}
            except BaseException as ex:  # e.g. no API key for the LLM extractor
                comp[name] = {"error": str(ex), "symptom_recall": None, "symptom_precision": None, "sensitivity": None, "specificity": None}
        rep["extractor_comparison"] = comp
    (OUTPUT_DIR / "evaluation_report.json").write_text(json.dumps(rep, indent=1, default=str), encoding="utf-8")
    (OUTPUT_DIR / "evaluation_report.md").write_text(to_markdown(rep), encoding="utf-8")
    print(to_markdown(rep))


if __name__ == "__main__":
    main()
