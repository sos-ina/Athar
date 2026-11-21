"""Explainable detection engine: combines the model score with transparent, configurable rules.

Order:
  1. INSUFFICIENT INFORMATION gate (before the model: a model will score anyone).
  2. Rule-based override: imaging suggestive of endometrioma/deep disease + pain -> review.
  3. Model score vs operating point (chosen on the synthetic development set).
  4. Guardrails that can block a flag (never add one): single visit, weak-only symptoms,
     alternative diagnosis that accounts for every symptom.
A normal investigation never lowers a flag; prescriptions and visit counts are never proof.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..config import rules
from ..schemas import Category
from ..temporal.features import FeatureSet


@dataclass
class Decision:
    category: Category
    priority: int
    reasons: list[str] = field(default_factory=list)
    guardrails: list[str] = field(default_factory=list)


def decide(fs: FeatureSet, score: float | None, threshold: float) -> Decision:
    cfg = rules()
    ins, g = cfg["insufficient_information"], cfg["flag_guardrails"]
    v = fs.values
    reasons: list[str] = []
    guards: list[str] = []
    n_rel, n_content = int(v["n_relevant_encounters"]), int(v["n_content_encounters"])
    if g.get("score_threshold_override") is not None:
        threshold = float(g["score_threshold_override"])

    # 1. insufficient information
    if n_content < ins["min_content_encounters"]:
        return Decision(Category.insufficient, 3, [f"Only {n_content} encounter(s) with meaningful documentation; at least {ins['min_content_encounters']} are needed to look for a pattern over time."])
    # 2. rule-based override (evidence doc: endometrioma on imaging is a strong finding)
    if v["suggestive_imaging"] and n_rel >= 1:
        reasons.append("Imaging report describes findings suggestive of endometrioma or deep disease, alongside documented pain (rule-based; not model-dependent).")
        return Decision(Category.review, 1, reasons, guards)

    if ins["single_relevant_encounter_is_insufficient"] and n_rel == 1 and n_content < 3:
        return Decision(Category.insufficient, 3, ["Relevant pain appears in a single encounter and the record is too short to tell whether it recurs."])
    if n_rel >= 1 and v["documentation_completeness"] < ins["min_documentation_completeness"] and n_content <= 2:
        return Decision(Category.insufficient, 3, ["Pain is mentioned but the notes do not document its timing, severity, cycle relationship or treatment; more history is needed."])

    if score is None:
        return Decision(Category.no_pattern, 4, ["No model available; rule-based checks found no override."])

    above = score >= threshold
    reasons.append(f"Model score {score:.2f} is {'at or above' if above else 'below'} the operating point {threshold:.3g} (illustrative score, not a probability).")

    # 4. guardrails
    blocked = False
    if above and n_rel < g["min_relevant_encounters"]:
        guards.append(f"Flag blocked: relevant pain documented in {n_rel} encounter(s); at least {g['min_relevant_encounters']} are required so a single visit never triggers a flag.")
        blocked = True
    strong_or_supp = sum(v[k] for k in ("n_dysmenorrhoea", "n_pelvic_pain", "n_dyspareunia", "n_dyschezia", "n_urinary", "n_subfertility"))
    if above and g["require_strong_or_supporting"] and strong_or_supp == 0:
        guards.append("Flag blocked: only nonspecific symptoms (e.g. fatigue, bloating, heavy bleeding) are documented; these never trigger a flag on their own.")
        blocked = True
    if above and v["alt_explains_all"] and v["n_strong_domains"] <= 1 and v["n_cyclical_nonmenstrual"] == 0:
        guards.append("Flag blocked: a documented alternative diagnosis accounts for every documented symptom and no cyclical link is recorded. The clinician may still choose to review.")
        blocked = True

    if above and not blocked:
        prio = 1 if (v["n_strong_domains"] >= cfg["priority"]["high_priority_min_strong_domains"] or v["persist_after_treatment"] and v["n_cyclical_nonmenstrual"]) else 2
        reasons.append(f"Relevant pain documented across {n_rel} separate encounters over {v['pain_span_months']:.0f} months.")
        return Decision(Category.review, prio, reasons, guards)
    if not above:
        reasons.append("The documented features do not add up to a notable pattern at the current operating point.")
    return Decision(Category.no_pattern, 4, reasons, guards)
