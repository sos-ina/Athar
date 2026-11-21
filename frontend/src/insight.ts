/** Turns an assessment into the pieces patient review draws: symptom domains, clinical signals, driver text. */
import { Assessment, Contributor, EvidenceRef } from "./api";

export type DomainState = "documented" | "uncertain" | "denied" | "unknown";
export interface Domain { key: string; short: string; label: string; state: DomainState; visits: number; refs: EvidenceRef[] }

const DOMAINS: { key: string; short: string; label: string; match: RegExp }[] = [
  { key: "dysmenorrhoea", short: "Periods", label: "Painful periods", match: /painful periods/i },
  { key: "pelvic_pain", short: "Pelvic", label: "Pelvic or lower abdominal pain", match: /pelvic/i },
  { key: "dyspareunia", short: "Sex", label: "Pain during or after sex", match: /sex/i },
  { key: "dyschezia", short: "Bowel", label: "Painful bowel movements", match: /bowel movements/i },
  { key: "urinary", short: "Urinary", label: "Urinary pain or blood", match: /urinary/i },
  { key: "subfertility", short: "Fertility", label: "Difficulty conceiving", match: /conceiving/i },
];

export function domains(a: Assessment): Domain[] {
  return DOMAINS.map((d) => {
    const refs = a.timeline.filter((t) => d.match.test(t.concept));
    const present = refs.filter((r) => r.status === "present");
    const state: DomainState = present.length ? "documented" : refs.some((r) => r.status === "uncertain") ? "uncertain" : refs.some((r) => r.status === "absent") ? "denied" : "unknown";
    return { key: d.key, short: d.short, label: d.label, state, visits: new Set(present.map((r) => r.encounter_id)).size, refs };
  });
}

export const LANE_ORDER = ["Painful periods", "Pelvic", "sex", "bowel movements", "Urinary", "conceiving", "Heavy menstrual", "Fatigue", "Bloating", "Altered bowel", "Back pain"];
export const laneName = (concept: string) => concept.split(" (")[0];
/** Symptoms that count as relevant pain or strong/supporting signs (nonspecific symptoms excluded). */
export const RELEVANT = /pelvic|periods|sex|bowel movements|urinary|conceiving/i;

export type SignalState = "yes" | "no" | "unknown" | "caution";
export interface Signal { key: string; title: string; state: SignalState; detail: string; encounters: string[] }

const ids = (refs: EvidenceRef[]) => [...new Set(refs.map((r) => r.encounter_id))];
const after = (refs: EvidenceRef[], date: string | null | undefined) => (date ? refs.filter((r) => r.encounter_date && r.encounter_date > date) : []);

/** Clinical signals drawn from NICE NG73's description of suspected endometriosis. */
export function signals(a: Assessment): Signal[] {
  const f = a.features;
  const pain = a.timeline.filter((t) => t.status === "present" && RELEVANT.test(t.concept));
  const meds = a.treatments_and_investigations.filter((t) => t.status === "medication");
  const fails = a.treatments_and_investigations.filter((t) => t.status === "treatment_response" && /not working/i.test(t.concept));
  const normals = a.treatments_and_investigations.filter((t) => t.status === "investigation" && /normal/i.test(t.concept) && !/abnormal/i.test(t.concept));
  const cyc = a.timeline.filter((t) => t.status === "present" && (t.menstrual_link === "explicit_yes" || /painful periods/i.test(t.concept)));
  const firstMed = meds.map((m) => m.encounter_date).filter(Boolean).sort()[0];
  const firstNormal = normals.map((m) => m.encounter_date).filter(Boolean).sort()[0];
  const nRel = f.n_relevant_encounters ?? 0, span = f.pain_span_months ?? 0;
  const strong = new Set(pain.map((p) => laneName(p.concept))).size;

  return [
    {
      key: "recurrence", title: "Pain keeps coming back",
      state: nRel >= 2 ? "yes" : nRel === 1 ? "no" : "unknown",
      detail: nRel >= 2 ? `${nRel} separate visits over ${Math.max(1, Math.round(span))} months` : nRel === 1 ? "Only one visit with relevant pain" : "No relevant pain documented",
      encounters: ids(pain),
    },
    {
      key: "cyclical", title: "Linked to her cycle",
      state: cyc.length ? "yes" : (f.n_explicit_noncyclical ?? 0) > 0 ? "no" : "unknown",
      detail: cyc.length ? `${ids(cyc).length} visit${ids(cyc).length > 1 ? "s" : ""} tie the pain to periods` : (f.n_explicit_noncyclical ?? 0) > 0 ? "Noted as not related to periods" : "Never documented either way",
      encounters: ids(cyc),
    },
    {
      key: "treatment", title: "Continues despite treatment",
      state: (f.persist_after_treatment ?? 0) > 0 || fails.length ? "yes" : meds.length ? "no" : "unknown",
      detail: fails.length ? `${fails.length} note${fails.length > 1 ? "s say" : " says"} treatment is not working` : (f.persist_after_treatment ?? 0) > 0 ? "Pain recorded after treatment began" : meds.length ? "No pain recorded after treatment" : "No pain treatment recorded",
      encounters: ids([...fails, ...after(pain, firstMed)]),
    },
    {
      key: "normal_test", title: "Continues after a normal test",
      state: (f.persist_after_normal_investigation ?? 0) > 0 ? "yes" : normals.length ? "no" : "unknown",
      detail: (f.persist_after_normal_investigation ?? 0) > 0 ? "A normal scan does not rule it out (NICE NG73)" : normals.length ? "No pain recorded after the normal test" : "No normal test on record",
      encounters: ids([...normals, ...after(pain, firstNormal)]),
    },
    {
      key: "domains", title: "Several kinds of pain",
      state: strong >= 2 ? "yes" : strong === 1 ? "no" : "unknown",
      detail: strong ? `${strong} different symptom type${strong > 1 ? "s" : ""}` : "None documented",
      encounters: ids(pain),
    },
    {
      key: "alternative", title: "Other explanation in the record",
      state: a.alternative_explanations.length ? "caution" : "no",
      detail: a.alternative_explanations.length ? ((f.alt_explains_all ?? 0) > 0 ? "May explain all the symptoms" : `${a.alternative_explanations[0].concept.split(" — ")[0]}, does not explain everything`) : "None documented",
      encounters: ids(a.alternative_explanations),
    },
  ];
}

const SHORT: Record<string, string> = {
  n_relevant_encounters: "repeated pain visits", pain_span_months: "how long the pain has gone on", n_strong_domains: "several symptom types",
  n_domains: "the number of symptom types", n_dysmenorrhoea: "painful periods", n_pelvic_pain: "pelvic pain", n_dyspareunia: "pain with sex",
  n_dyschezia: "painful bowel movements", n_urinary: "urinary symptoms", n_subfertility: "difficulty conceiving", n_hmb: "heavy bleeding",
  n_weak_symptoms: "only nonspecific symptoms", n_cyclical_nonmenstrual: "pain linked to her cycle", n_explicit_noncyclical: "pain noted as not cycle-related",
  severe_or_impact: "severe or disruptive pain", persist_after_treatment: "pain after treatment began", documented_treatment_failure: "treatment not working",
  documented_treatment_success: "improvement on treatment", persist_after_normal_investigation: "pain after a normal test", suggestive_imaging: "suggestive imaging",
  n_alt_explanations: "another diagnosis recorded (e.g. IBS), common before endometriosis is found", alt_explains_all: "an explanation for all symptoms", escalation: "visits increasing recently",
  gyn_referral: "a gynaecology referral", family_history: "family history", n_uncertain: "uncertain mentions", documentation_completeness: "how complete the notes are",
  record_span_months: "the length of her record", age: "her age",
};
export const shortLabel = (c: Contributor) => {
  if (c.feature === "n_weak_symptoms" && c.value === 0) return "no visits with only nonspecific symptoms";
  if (c.feature === "n_alt_explanations" && c.value === 0) return "no other diagnosis recorded";
  const s = SHORT[c.feature] ?? c.label.toLowerCase();
  return c.feature.startsWith("n_") && c.value === 0 ? `no documented ${s}` : s;
};
/** Model scores are shown to two decimals; values that would round to 1.00 read as "> 0.99" (never a certainty). */
export const fmtScore = (s: number) => (s > 0.99 ? "> 0.99" : s.toFixed(2));
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function fmtValue(c: Contributor): string {
  const v = c.value;
  if (c.feature === "family_history") return v > 0 ? "Yes" : v < 0 ? "Not recorded" : "No";
  if (["gyn_referral", "suggestive_imaging", "escalation", "alt_explains_all", "persist_after_treatment", "persist_after_normal_investigation"].includes(c.feature)) return v > 0 ? "Yes" : "No";
  if (c.feature.endsWith("_months")) return `${v.toFixed(v < 10 ? 1 : 0)} mo`;
  if (c.feature === "age") return `${v} y`;
  if (c.feature === "documentation_completeness") return `${Math.round(v * 100)}%`;
  if (c.feature.startsWith("n_") || c.feature.startsWith("documented_") || c.feature === "severe_or_impact")
    return c.feature.includes("domains") ? `${v}` : `${v} visit${v === 1 ? "" : "s"}`;
  return Number.isInteger(v) ? `${v}` : v.toFixed(1);
}

export function driverSentence(a: Assessment): string {
  const up = a.contributors.filter((c) => c.direction === "raises").slice(0, 2).map(shortLabel);
  const down = a.contributors.filter((c) => c.direction === "lowers").slice(0, 1).map(shortLabel);
  if (!up.length && !down.length) return "";
  let s = up.length ? `Driven mostly by ${up.join(" and ")}` : "";
  if (down.length) s += `${s ? "; " : ""}${s ? down[0] : cap(down[0])} pulls it down`;
  return s + ".";
}

export const operatingPoint = (a: Assessment) => {
  const m = a.reasons.join(" ").match(/operating point ([\d.]+)/);
  return m ? Number(m[1]) : null;
};
