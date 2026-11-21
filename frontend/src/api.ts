export type CategoryKey = "review" | "insufficient" | "no_pattern";

export interface EvidenceRef {
  encounter_id: string;
  encounter_date: string | null;
  quote: string;
  concept: string;
  status: string;
  menstrual_link?: string | null;
}

export interface Contributor {
  feature: string;
  label: string;
  value: number;
  shap: number;
  direction: "raises" | "lowers";
  evidence: EvidenceRef[];
}

export interface Issue { encounter_id: string | null; kind: string; detail: string }

export interface Assessment {
  patient_id: string;
  category: string;
  model_score: number | null;
  priority: number;
  reasons: string[];
  guardrails_applied: string[];
  contributors: Contributor[];
  features: Record<string, number>;
  relevant_encounters: number;
  timeline: EvidenceRef[];
  treatments_and_investigations: EvidenceRef[];
  alternative_explanations: EvidenceRef[];
  missing_or_uncertain: string[];
  data_quality: Issue[];
  summary: string;
  summary_source: "llm" | "template";
  extractor: string;
  disclaimer: string;
  temporal_patterns: { kind: string; text: string; evidence: EvidenceRef[] }[];
  visits_by_year: { year: number; pain_visits: number; other_visits: number }[];
}

export interface Encounter {
  encounter_id: string;
  date: string | null;
  setting: string;
  clinician: string | null;
  note_text: string;
  coded_diagnoses: string[];
  medications: { name: string }[];
  investigations: { type: string; result_text: string }[];
  referrals: { to: string; reason: string }[];
}

export interface PatientRecord { patient_id: string; birth_year: number | null; family_history_text: string | null; encounters: Encounter[] }

export interface PatientRow {
  patient_id: string;
  age: number | null;
  n_encounters: number;
  category: string;
  category_key: CategoryKey;
  priority: number;
  model_score: number | null;
  relevant_encounters: number;
  first_date: string | null;
  last_date: string | null;
  headline: string;
  key_features: string[];
  data_quality_issues: number;
  sceptic_verdict: "upheld" | "weakened" | "challenged" | null;
  referred?: boolean; // gynaecology referral recorded (absent from older API versions)
}

export interface PatientList { dataset: string; extractor: string; counts: Record<CategoryKey, number>; patients: PatientRow[] }

export interface Challenge { type: "misread" | "alternative" | "gap"; severity: "major" | "minor"; claim: string; encounter_id: string | null; quote: string; finding_ids: string[]; correction: string | null; verified: boolean; rejected_reason: string | null }
export interface Sceptic { ran: boolean; model: string | null; verdict: "upheld" | "weakened" | "challenged" | "not_run"; summary: string; challenges: Challenge[]; original_category: string; final_category: string; changed: boolean; reason: string; corrections_applied: string[]; score_before: number | null; score_after: number | null }
export interface Decision { decision: "agree" | "dismiss" | "more_info"; note: string; at: string }

export interface PatientDetail {
  record: PatientRecord;
  assessment: Assessment;
  sceptic: Sceptic | null;
  decision: Decision | null;
  n_findings: number;
  synthetic_truth?: { endometriosis: boolean; scenario_name: string; subtype: string; expected_category: string } | null;
}

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${r.status})`);
  }
  return r.json();
}

async function send<T>(url: string, body: unknown): Promise<T> {
  return get<T>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export const api = {
  decide: (id: string, dataset: string, body: { decision: string; note: string }) => send<Decision>(`/api/patients/${id}/decision?dataset=${dataset}`, body),
  health: () => get<{ model_loaded: boolean; model: string; llm_available: boolean; llm_model: string; extractor_by_dataset: Record<string, string> }>("/api/health"),
  patients: (dataset: string) => get<PatientList>(`/api/patients?dataset=${dataset}`),
  patient: (id: string, dataset: string, truth: boolean) => get<PatientDetail>(`/api/patients/${id}?dataset=${dataset}&include_truth=${truth}`),
  summary: (id: string, dataset: string) => get<{ summary: string; source: string }>(`/api/patients/${id}/summary?dataset=${dataset}`, { method: "POST" }),
  evaluation: () => get<any>("/api/evaluation"),
  model: () => get<any>("/api/model"),
  overview: (dataset: string) => get<any>(`/api/overview?dataset=${dataset}`),
};

export const CATEGORY_KEY: Record<string, CategoryKey> = {
  "PATTERN WARRANTS CLINICAL REVIEW": "review",
  "INSUFFICIENT INFORMATION": "insufficient",
  "NO NOTABLE PATTERN IDENTIFIED": "no_pattern",
};

export const CATEGORY_TEXT: Record<CategoryKey, { short: string; long: string }> = {
  review: { short: "Warrants review", long: "Pattern warrants clinical review" },
  insufficient: { short: "Needs more history", long: "Insufficient information" },
  no_pattern: { short: "No notable pattern", long: "No notable pattern identified" },
};

export const fmtDate = (d: string | null) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "No date";
