# Athar evaluation report (synthetic held-out set)

> These results measure performance on synthetic data generated for development. They show that the pipeline behaves as designed on constructed scenarios; they do NOT demonstrate clinical accuracy. Real-world performance requires real, labelled, de-identified records and external validation.

Extractor: `llm:anthropic/claude-sonnet-5.5-20260928` · Model: `logistic_regression` (threshold 0.399, highest score threshold with out-of-fold sensitivity >= 80% on the development set) · Patients: 200

## Model comparison (5-fold CV on development set)

| Model | CV ROC-AUC | CV avg precision |
|---|---|---|
| logistic_regression | 0.857 | 0.814 |
| random_forest | 0.83 | 0.775 |
| xgboost | 0.851 | 0.787 |

## A. Constructed-scenario agreement

Rows = category the scenario was built to show; columns = Athar's output.

| expected \ predicted | REVIEW | INSUFFICIENT | NO PATTERN |
|---|---|---|---|
| REVIEW | 66 | 0 | 38 |
| INSUFFICIENT | 2 | 9 | 3 |
| NO PATTERN | 7 | 0 | 75 |

Three-class accuracy: **0.75**

**Review vs not (constructed)** — sensitivity 0.635, specificity 0.906, precision 0.88, F1 0.737, FPR 0.094, FNR 0.365 (TP 66, FP 9, TN 87, FN 38)

**Insufficient-information detection** — sensitivity 0.643, specificity 1.0, precision 1.0, F1 0.783, FPR 0.0, FNR 0.357 (TP 9, FP 0, TN 186, FN 5)

## B. Agreement with the hidden synthetic label

**Flag vs hidden label** — sensitivity 0.712, specificity 0.819, precision 0.693, F1 0.703, FPR 0.181, FNR 0.288 (TP 52, FP 23, TN 104, FN 21)

Model-score ROC-AUC on the evaluation set: **0.867** (published symptom-based models: ~0.65–0.85).

## C. Does the AI beat simple rules?

Guideline-only rules applied to the SAME extracted features Athar uses (no model, no LLM at decision time), scored against the hidden synthetic label. INSUFFICIENT counts as not flagged.

95% CIs from 1000 paired bootstrap resamples of patients (seed 20260101). 200 patients, 73 with the hidden label.

- **Guideline rule A**: >=2 separate visits with relevant pain AND >=1 strong symptom domain (painful periods, pelvic pain, pain with sex or painful bowel movements).
- **Guideline rule B**: Rule A AND at least one of: non-period pain explicitly linked to the cycle, pain persisting >=8 weeks after a pain treatment was started, or pain documented after a normal investigation.

| Method | Sensitivity | Specificity | Precision | Flagged | False positives |
|---|---|---|---|---|---|
| Athar | 0.712 (0.608 to 0.819) | 0.819 (0.75 to 0.881) | 0.693 (0.59 to 0.798) | 75 (62 to 88) | 23 (14 to 32) |
| Guideline rule A | 0.795 (0.693 to 0.886) | 0.26 (0.185 to 0.336) | 0.382 (0.312 to 0.458) | 152 (140 to 165) | 94 (80 to 107) |
| Guideline rule B | 0.712 (0.606 to 0.812) | 0.472 (0.389 to 0.562) | 0.437 (0.353 to 0.527) | 119 (106 to 133) | 67 (53 to 80) |

Athar minus rule (paired bootstrap):

| Comparison | Sensitivity | Specificity | Precision | Flagged | False positives |
|---|---|---|---|---|---|
| Athar minus Guideline rule A | -0.082 (-0.15 to -0.027) | 0.559 (0.475 to 0.643) | 0.312 (0.238 to 0.393) | -77 (-90 to -64) | -71 (-84 to -58) |
| Athar minus Guideline rule B | 0.0 (-0.076 to 0.079) | 0.346 (0.248 to 0.45) | 0.256 (0.175 to 0.345) | -44 (-58 to -28) | -44 (-58 to -31) |

Athar model-score ROC-AUC: **0.867 (0.818 to 0.916)** (n=200).

Rules give yes/no flags, so they have no ROC-AUC. A difference whose CI excludes 0 is unlikely to be bootstrap noise on this synthetic set; it is still not evidence about real patients.

## D. What Athar misses, and why

21 of 73 label-positive patients were not flagged (threshold 0.399).

**Built without a visible pattern: 20.** Label positive but built to show something other than a reviewable pattern (expected category is not REVIEW): silent records, isolated symptoms, sparse records, period pain only. No record-based tool can be expected to flag these.

- Scenario / subtype: routine_unrelated / silent (6), isolated_symptom / isolated (5), insufficient_records / sparse_record (4), dysmenorrhoea_only / primary_dysmenorrhoea_like (1), overlapping_conditions / overlap_adenomyosis (1), pelvic_pain_no_menstrual_link / noncyclical_documentation (1), dysmenorrhoea_only / dysmenorrhoea_persistent (1), overlapping_conditions / overlap_fibroids (1)
- Final category: NO NOTABLE PATTERN IDENTIFIED (17), INSUFFICIENT INFORMATION (3)
- Why not flagged: Model score below the threshold (11), Guardrail: pain at fewer than 2 visits (6), Guardrail: only nonspecific symptoms (6), Pain at a single visit in a short record (needs more history) (2), Too few documented visits (needs more history) (1)
- Model score: At or above the threshold (8), Close: at least half the threshold (7), Low: under half the threshold (5); median 0.369

**Genuine misses: 1.** Label positive and built to show a reviewable pattern in the notes, but not flagged.

- Scenario / subtype: overlapping_conditions / overlap_interstitial_cystitis (1)
- Why not flagged: Model score below the threshold (1)
- Model score: Low: under half the threshold (1); median 0.133
- Most common pattern gaps: No pain recorded as persisting after treatment or a normal test (1)

| Patient | Scenario / subtype | Outcome | Why not flagged | Score | Main missing features |
|---|---|---|---|---|---|
| EVL-0027 | overlapping_conditions / overlap_interstitial_cystitis | NO NOTABLE PATTERN IDENTIFIED | Model score below the threshold | 0.133 | No pain recorded as persisting after treatment or a normal test; model lowered by: Visits documenting urinary pain/blood (4), Months between first and last relevant pain (44.3), Different strong symptom domains documented (1); Painful bowel movements are neither documented nor explicitly denied.; Family history of endometriosis is not recorded. |

A record-based tool cannot find patients whose records are silent; a patient self-check route is planned for them.

## Subgroups

| Subgroup | n | sens (constructed) | spec (constructed) | sens (label) | spec (label) |
|---|---|---|---|---|---|
| incomplete_records | 63 | 0.659 | 0.864 | 0.839 | 0.875 |
| alternative_condition_scenarios | 74 | 0.757 | 0.892 | 0.818 | 0.731 |
| varied_terminology | 10 | 0.556 | 1.0 | 1.0 | 1.0 |
| inconsistent_documentation | 17 | 0.471 | None | 1.0 | 1.0 |
| silent_positives_and_routine | 16 | None | 1.0 | 0.0 | 1.0 |

## Extraction quality (vs generator ground truth)

Symptom precision 0.994, recall 0.996, status accuracy 0.998, menstrual-link accuracy 0.96.

## LLM vs keyword extractor

| Extractor | symptom recall | precision | flag sensitivity (label) | specificity (label) |
|---|---|---|---|---|
| lexicon | 0.936 | 0.998 | 0.685 | 0.795 |
| llm:anthropic/claude-sonnet-5.5-20260928 | 0.996 | 0.994 | 0.712 | 0.819 |
