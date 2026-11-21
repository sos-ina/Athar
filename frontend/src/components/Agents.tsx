import { useState } from "react";
import { api, CATEGORY_KEY, CATEGORY_TEXT, Decision, fmtDate, PatientDetail } from "../api";
import { fmtScore, operatingPoint, RELEVANT } from "../insight";

type StepState = "done" | "changed" | "skipped" | "pending";
interface Step { who: string; role: string; text: string; state: StepState }

/** Every step from record to decision, with who did it: the AI, code, the model, the rules, the sceptic or the doctor. */
export function AgentTrace({ d, extractor }: { d: PatientDetail; extractor: string }) {
  const a = d.assessment, s = d.sceptic;
  const rejectedQuotes = a.data_quality.filter((q) => q.kind === "unverified_quote").length;
  const painVisits = new Set(a.timeline.filter((t) => t.status === "present" && RELEVANT.test(t.concept)).map((t) => t.encounter_id)).size;
  const op = operatingPoint(a);
  const before = s?.original_category ?? a.category;
  const beforeKey = CATEGORY_KEY[before];
  const isLLM = extractor === "llm";
  const verified = s?.challenges.filter((c) => c.verified && c.type !== "gap").length ?? 0;
  const gaps = s?.challenges.filter((c) => c.type === "gap").length ?? 0;
  const rejected = s?.challenges.filter((c) => !c.verified).length ?? 0;
  const dec = d.decision;

  const steps: Step[] = [
    { who: isLLM ? "LLM reader" : "Keyword reader", role: "AI", state: "done",
      text: `Read ${d.record.encounters.length} visits and kept ${d.n_findings} findings, each tied to a quote checked against the note${rejectedQuotes ? `; ${rejectedQuotes} discarded because the quote was not found` : ""}.` },
    { who: "Timeline", role: "Code", state: "done",
      text: painVisits ? `Lined up ${painVisits} visits with relevant pain over ${Math.max(1, Math.round(a.features.pain_span_months ?? 0))} months and measured ${Object.keys(a.features).length} features.` : `No visits with relevant pain. Measured ${Object.keys(a.features).length} features.` },
    { who: "Model", role: "ML", state: a.model_score === null ? "skipped" : "done",
      text: a.model_score === null ? "Not scored: the record was too thin to score." : `Pattern score ${fmtScore(a.model_score)}${op !== null ? ` against a review threshold of ${op}` : ""}. Not a probability.` },
    { who: "Clinical rules", role: "Code", state: "done",
      text: `${CATEGORY_TEXT[beforeKey].long}.${a.guardrails_applied.filter((g) => !g.startsWith("Flag downgraded by the sceptic")).length ? " A guardrail held the flag back." : ""}` },
    s?.ran
      ? { who: "Sceptic reviewer", role: "AI", state: s.changed ? "changed" : "done",
          text: `${verified ? `${verified} challenge${verified > 1 ? "s" : ""} verified` : "No verified challenge"}${gaps ? `, ${gaps} gap${gaps > 1 ? "s" : ""} noted` : ""}${rejected ? `, ${rejected} discarded` : ""}. ${s.changed ? `Downgraded to “${CATEGORY_TEXT[CATEGORY_KEY[s.final_category]].short}”.` : "The flag stands."}` }
      : { who: "Sceptic reviewer", role: "AI", state: "skipped", text: beforeKey === "review" ? "Not run on this record yet." : "Only flagged records are challenged." },
    { who: "Doctor", role: "Human", state: dec ? "done" : "pending",
      text: dec ? `${dec.decision === "agree" ? "Agreed to assess" : dec.decision === "dismiss" ? "Dismissed the flag" : "Asked for more information"} on ${fmtDate(dec.at.slice(0, 10))}.` : "Waiting for your decision." },
  ];

  return (
    <ol className="trace-flow" aria-label="How Athar reached this outcome">
      {steps.map((st, i) => (
        <li key={i} className={`tf-step st-${st.state}`}>
          <span className="tf-num" aria-hidden>{i + 1}</span>
          <div>
            <p className="tf-who">{st.who} <span className="tf-role">{st.role}</span></p>
            <p className="tf-text">{st.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const TYPE_TEXT = { misread: "Possible misread", alternative: "Other explanation", gap: "Gap in the record" };

export function ScepticPanel({ d, onQuote }: { d: PatientDetail; onQuote: (encounterId: string, quote: string) => void }) {
  const s = d.sceptic;
  const [showRejected, setShowRejected] = useState(false);
  const key = CATEGORY_KEY[d.assessment.category];
  if (!s || !s.ran) {
    return (
      <div className="ws-sec">
        <h3>Sceptic review</h3>
        <p className="small muted">{key === "review" || s?.original_category === "PATTERN WARRANTS CLINICAL REVIEW" ? "The sceptic reviewer has not checked this flag yet." : "The sceptic only challenges flagged records."}</p>
      </div>
    );
  }
  const kept = s.challenges.filter((c) => c.verified);
  const dropped = s.challenges.filter((c) => !c.verified);
  return (
    <div className="ws-sec sceptic">
      <h3>Sceptic review <span className={`verdict v-${s.verdict}`}>{s.verdict === "upheld" ? "Flag upheld" : s.verdict === "weakened" ? "Flag weakened" : "Flag challenged"}</span></h3>
      {s.summary && <p className="sc-summary">{s.summary}</p>}
      {s.changed && <p className="sc-changed">Downgraded from “{CATEGORY_TEXT[CATEGORY_KEY[s.original_category]].short}”. {s.reason}</p>}
      {kept.length > 0 && (
        <ul className="sc-list">
          {kept.map((c, i) => (
            <li key={i} className={`sc-item t-${c.type} sev-${c.severity}`}>
              <p className="sc-type">{TYPE_TEXT[c.type]}{c.severity === "major" && c.type !== "gap" ? " · major" : ""}</p>
              <p className="sc-claim">{c.claim}</p>
              {c.quote && c.encounter_id && <button className="sc-quote" onClick={() => onQuote(c.encounter_id!, c.quote)}>“{c.quote}”</button>}
            </li>
          ))}
        </ul>
      )}
      {s.corrections_applied.length > 0 && (
        <div className="sc-fixes"><p className="small"><b>Corrected before re-scoring</b>{s.score_after !== null && s.score_before !== null ? ` (score ${fmtScore(s.score_before)} → ${fmtScore(s.score_after)})` : ""}</p>
          <ul className="plain">{s.corrections_applied.map((n, i) => <li key={i} className="small">{n}</li>)}</ul></div>
      )}
      {dropped.length > 0 && (
        <p className="small muted">
          <button className="link" onClick={() => setShowRejected(!showRejected)}>{dropped.length} challenge{dropped.length > 1 ? "s" : ""} discarded by code</button>, because the quote could not be found in the note.
        </p>
      )}
      {showRejected && <ul className="plain">{dropped.map((c, i) => <li key={i} className="small muted">{c.claim} ({c.rejected_reason})</li>)}</ul>}
    </div>
  );
}

export function DecisionPanel({ id, dataset, decision, onSaved }: { id: string; dataset: string; decision: Decision | null; onSaved: (d: Decision) => void }) {
  const [editing, setEditing] = useState(!decision);
  const [choice, setChoice] = useState<Decision["decision"] | null>(decision?.decision ?? null);
  const [note, setNote] = useState(decision?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const label = { agree: "Agree, assess her", more_info: "Ask for more information", dismiss: "Dismiss the flag" };
  if (decision && !editing) {
    return (
      <div className="ws-sec decision">
        <h3>Your decision</h3>
        <p className="dec-saved"><b>{label[decision.decision]}</b>{decision.note && <span>{decision.note}</span>}<small>Recorded {fmtDate(decision.at.slice(0, 10))}, {decision.at.slice(11, 16)}</small></p>
        <button className="link" onClick={() => setEditing(true)}>Change decision</button>
      </div>
    );
  }
  const save = () => {
    if (!choice) return;
    setBusy(true); setErr("");
    api.decide(id, dataset, { decision: choice, note }).then((d) => { onSaved(d); setEditing(false); }).catch((e) => setErr(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="ws-sec decision">
      <h3>Your decision</h3>
      <div className="dec-options" role="radiogroup" aria-label="Your decision">
        {(Object.keys(label) as Decision["decision"][]).map((k) => (
          <button key={k} role="radio" aria-checked={choice === k} className={`dec-opt d-${k}`} onClick={() => setChoice(k)}>{label[k]}</button>
        ))}
      </div>
      <textarea className="dec-note" rows={2} placeholder={choice === "dismiss" ? "Reason for dismissing (required)" : "Note (optional)"} value={note} onChange={(e) => setNote(e.target.value)} />
      {err && <p className="error small">{err}</p>}
      <button className="btn btn-primary" disabled={!choice || busy || (choice === "dismiss" && !note.trim())} onClick={save}>{busy ? "Saving…" : "Record decision"}</button>
    </div>
  );
}
