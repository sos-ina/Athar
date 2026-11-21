import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, CATEGORY_KEY, CATEGORY_TEXT, CategoryKey, EvidenceRef, fmtDate, PatientDetail, PatientList } from "../api";
import { cap, RELEVANT, domains as getDomains, driverSentence, fmtScore, fmtValue, operatingPoint, shortLabel, Signal, signals as getSignals } from "../insight";
import { useSettings } from "../settings";
import PatternMap, { journeySentence } from "./PatternMap";
import SymptomWheel from "./SymptomWheel";
import { AgentTrace, DecisionPanel, ScepticPanel } from "./Agents";

const ORDER: CategoryKey[] = ["review", "insufficient", "no_pattern"];

function Highlighted({ text, quote }: { text: string; quote?: string }) {
  const q = quote?.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (!q || i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function since(fromIso: string, toIso: string) {
  const m = Math.max(0, Math.round((+new Date(toIso) - +new Date(fromIso)) / (30.44 * 86400000)));
  const y = Math.floor(m / 12), r = m % 12;
  return y ? `${y} year${y > 1 ? "s" : ""}${r ? ` ${r} month${r > 1 ? "s" : ""}` : ""}` : `${m} month${m === 1 ? "" : "s"}`;
}
const monthYear = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });

/** The questions a doctor asks first: how long has the pain been in the record, what was tried, was she referred. */
function RecordFacts({ d }: { d: PatientDetail }) {
  const a = d.assessment;
  const dates = d.record.encounters.map((e) => e.date).filter(Boolean).sort() as string[];
  const last = dates[dates.length - 1];
  const pain = a.timeline.filter((t) => t.status === "present" && RELEVANT.test(t.concept) && t.encounter_date).map((t) => t.encounter_date!).sort();
  const painVisits = new Set(a.timeline.filter((t) => t.status === "present" && RELEVANT.test(t.concept)).map((t) => t.encounter_id)).size;
  const tried = [...new Set(a.treatments_and_investigations.filter((t) => t.status === "medication").map((t) => t.concept))];
  const gyn = a.treatments_and_investigations.filter((t) => t.status === "referral" && /gyn/i.test(t.concept) && t.encounter_date).map((t) => t.encounter_date!).sort()[0];
  const rows: [string, JSX.Element][] = [
    ["Pain first recorded", pain.length && last ? <><b>{monthYear(pain[0])}</b><small>{since(pain[0], last)} before the latest visit</small></> : <b className="muted">Never</b>],
    ["Visits with relevant pain", <><b>{painVisits} of {d.record.encounters.length}</b><small>{dates.length ? `Record covers ${since(dates[0], last)}` : ""}</small></>],
    ["Treatments tried", tried.length ? <><b>{tried.length}</b><small>{tried.join(", ")}</small></> : <b className="muted">None recorded</b>],
    ["Gynaecology referral", gyn ? <><b>{monthYear(gyn)}</b>{pain.length ? <small>{since(pain[0], gyn)} after pain was first recorded</small> : null}</> : <b className={pain.length ? "warn" : "muted"}>Not yet</b>],
  ];
  return (
    <dl className="facts">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

function ExplainDrawer({ d, onClose, onPick }: { d: PatientDetail; onClose: () => void; onPick: (r: EvidenceRef) => void }) {
  const { settings } = useSettings();
  const a = d.assessment;
  const [summary, setSummary] = useState({ text: a.summary, source: a.summary_source as string });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const max = Math.max(0.01, ...a.contributors.map((c) => Math.abs(c.shap)));
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Full explanation" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h2>Full explanation</h2><button className="btn-quiet" onClick={onClose}>Close</button></div>
        <section>
          <h3>Summary</h3>
          <p>{summary.text}</p>
          <p className="small muted">{summary.source === "llm" ? "Written by the LLM from the findings below only." : "Generated from the findings below."}
            {summary.source !== "llm" && <> <button className="link" disabled={busy} onClick={() => { setBusy(true); api.summary(a.patient_id, settings.dataset).then((s) => setSummary({ text: s.summary, source: s.source })).catch((e) => setErr(e.message)).finally(() => setBusy(false)); }}>{busy ? "Writing…" : "Write AI summary"}</button></>}</p>
          {err && <p className="error small">{err}</p>}
        </section>
        <section><h3>Why this outcome</h3><ul className="reasons">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          {a.guardrails_applied.length > 0 && <ul className="guards">{a.guardrails_applied.map((g, i) => <li key={i}>{g}</li>)}</ul>}</section>
        {a.temporal_patterns.length > 0 && <section><h3>Patterns over time</h3><ul className="plain">{a.temporal_patterns.map((p, i) => <li key={i}>{p.text}</li>)}</ul></section>}
        <section>
          <h3>Every factor the model weighed</h3>
          <ul className="contrib">
            {a.contributors.map((c) => (
              <li key={c.feature}>
                <div className="contrib-row"><span>{cap(shortLabel(c))}</span><span className="contrib-val">{fmtValue(c)} · {c.direction}</span></div>
                <span className={`bar ${c.direction === "raises" ? "up" : "down"}`} style={{ width: `${(Math.abs(c.shap) / max) * 100}%` }} />
                {c.evidence.length > 0 && <div className="ev">{c.evidence.slice(0, 5).map((e, i) => <button key={i} className="ev-chip" onClick={() => onPick(e)}>{fmtDate(e.encounter_date)}</button>)}</div>}
              </li>
            ))}
          </ul>
        </section>
        <section><h3>Other explanations in the record</h3>{a.alternative_explanations.length ? <ul className="plain">{a.alternative_explanations.map((x, i) => <li key={i}><button className="link" onClick={() => onPick(x)}>{x.concept.split(" — ")[0]}</button>{x.concept.includes(" — ") && <span className="muted"> {x.concept.split(" — ")[1]}</span>}</li>)}</ul> : <p className="muted">None documented.</p>}</section>
        <section><h3>Missing or uncertain</h3>{a.missing_or_uncertain.length ? <ul className="plain">{a.missing_or_uncertain.map((m, i) => <li key={i}>{m}</li>)}</ul> : <p className="muted">Nothing flagged.</p>}</section>
        <section><h3>Record quality</h3>{a.data_quality.length ? <ul className="plain">{a.data_quality.map((q, i) => <li key={i}>{q.detail}</li>)}</ul> : <p className="muted">No problems found.</p>}</section>
        <p className="disclaimer">{a.disclaimer} Notes read by: {a.extractor}.</p>
      </aside>
    </div>
  );
}

export default function Workstation() {
  const { id } = useParams();
  const nav = useNavigate();
  const { settings } = useSettings();
  const [list, setList] = useState<PatientList | null>(null);
  const [d, setD] = useState<PatientDetail | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<CategoryKey | "all">("review");
  const [q, setQ] = useState("");
  const [notReferred, setNotReferred] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [hl, setHl] = useState<{ key: string; ids: Set<string> } | null>(null);
  const [picked, setPicked] = useState<{ enc: string; quote?: string } | null>(null);

  useEffect(() => { setList(null); api.patients(settings.dataset).then(setList).catch((e) => setErr(e.message)); }, [settings.dataset]);
  useEffect(() => {
    if (!list) return;
    if (!id || !list.patients.some((p) => p.patient_id === id)) {
      const first = list.patients.find((p) => p.category_key === "review") ?? list.patients[0];
      if (first) nav(`/review/${first.patient_id}`, { replace: true });
    }
  }, [list, id]);
  useEffect(() => {
    if (!id) return;
    setD(null); setHl(null); setPicked(null); setReveal(false); setExplainOpen(false);
    api.patient(id, settings.dataset, true).then(setD).catch((e) => setErr(e.message));
  }, [id, settings.dataset]);

  const rows = useMemo(() => (list?.patients ?? []).filter((p) => (filter === "all" || p.category_key === filter) && (!notReferred || p.referred === false) && p.patient_id.toLowerCase().includes(q.toLowerCase())), [list, filter, q, notReferred]);
  const notReferredCount = (list?.patients ?? []).filter((p) => (filter === "all" || p.category_key === filter) && p.referred === false).length;
  const nav3 = useMemo(() => {
    const cur = list?.patients.find((p) => p.patient_id === id);
    const same = (list?.patients ?? []).filter((p) => p.category_key === cur?.category_key);
    const i = same.findIndex((p) => p.patient_id === id);
    return { cur, same, i };
  }, [list, id]);

  if (err) return <p className="error pad">{err}</p>;
  if (!d) return <div className="ws"><p className="muted pad">Loading patient review…</p></div>;

  const a = d.assessment;
  const key = CATEGORY_KEY[a.category];
  const doms = getDomains(a);
  const sigs = getSignals(a);
  const op = operatingPoint(a);
  const lastDate = d.record.encounters.map((e) => e.date).filter(Boolean).sort().slice(-1)[0];
  const age = d.record.birth_year && lastDate ? Number(lastDate.slice(0, 4)) - d.record.birth_year : null;
  const encounter = picked ? d.record.encounters.find((e) => e.encounter_id === picked.enc) : null;
  const toggle = (k: string, ids: string[]) => setHl(hl?.key === k ? null : { key: k, ids: new Set(ids) });
  const pick = (enc: string, ref?: EvidenceRef) => setPicked({ enc, quote: ref?.quote });
  const go = (delta: number) => { const p = nav3.same[nav3.i + delta]; if (p) nav(`/review/${p.patient_id}`); };

  return (
    <div className="ws">
      <div className="ws-bar">
        <button className="ws-queue-btn" onClick={() => setQueueOpen(true)} aria-label="Open the patient list">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M4 7h16M4 12h16M4 17h10" /></svg>Patients
          {list && <span className="tab-badge">{list.counts.review}</span>}
        </button>
        <div className="ws-nav">
          <button onClick={() => go(-1)} disabled={nav3.i <= 0} aria-label="Previous patient">‹</button>
          <span className="ws-id">{a.patient_id}</span>
          <button onClick={() => go(1)} disabled={nav3.i < 0 || nav3.i >= nav3.same.length - 1} aria-label="Next patient">›</button>
        </div>
        <span className="ws-pos muted">{nav3.i >= 0 ? `${nav3.i + 1} of ${nav3.same.length} in “${CATEGORY_TEXT[key].short}”` : ""}</span>
      </div>

      <AgentTrace d={d} extractor={list?.extractor ?? "llm"} />

      <div className="ws-grid">
        {/* ------------------------------------------------ left: the patient */}
        <aside className="card ws-left">
          <div>
            <p className="ws-kicker">Patient</p>
            <h2 className="ws-who">{age ? `${age}-year-old woman` : "Woman, age unknown"}</h2>
          </div>
          <RecordFacts d={d} />
          <div className="ws-sec">
            <h3>What drives this outcome</h3>
            <ul className="drivers">
              {a.contributors.slice(0, 6).map((c) => {
                const ids = c.evidence.map((e) => e.encounter_id);
                return (
                  <li key={c.feature}>
                    <button className={`drv ${c.direction} ${hl?.key === c.feature ? "is-on" : ""}`} disabled={!ids.length} onClick={() => toggle(c.feature, ids)}>
                      <span className="drv-name">{cap(shortLabel(c))}</span>
                      <span className="drv-val">{fmtValue(c)}</span>
                      <span className="drv-dir" aria-label={c.direction}>{c.direction === "raises" ? "▲" : "▼"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <button className="link-row" onClick={() => setExplainOpen(true)}>All {a.contributors.length} factors and the full reasoning ›</button>
          </div>
        </aside>

        {/* ------------------------------------------------ centre: the pattern map */}
        <section className="card ws-stage">
          <div className="stage-head">
            <h2>Pain and treatment over time</h2>
            <div className="stage-legend">
              <span><i className="lg-dot" />Visit with pain (bigger = more symptom types)</span>
              <span><i className="lg-ring" />Linked to periods</span>
              <span><i className="lg-x">×</i>Treatment not working</span>
              <span><i className="lg-test" />Test</span>
            </div>
          </div>
          <p className="stage-story">{journeySentence(a)}</p>
          <PatternMap record={d.record} a={a} highlight={hl?.ids ?? null} picked={picked?.enc ?? null} onPick={pick} />
          {encounter && (
            <div className="note-card" role="region" aria-label="Source note">
              <div className="note-head">
                <p><b>{fmtDate(encounter.date)}</b> · {encounter.setting.replaceAll("_", " ")}{encounter.clinician ? ` · ${encounter.clinician}` : ""} <span className="muted">({encounter.encounter_id})</span></p>
                <button className="btn-quiet" onClick={() => setPicked(null)}>Close note</button>
              </div>
              <pre className="note"><Highlighted text={encounter.note_text} quote={picked?.quote} /></pre>
              {encounter.investigations.map((i, k) => <p key={k} className="small"><b>Result:</b> {i.result_text}</p>)}
            </div>
          )}
          <div className="stage-lower">
            <div className="ws-sec">
              <h3>Symptom groups</h3>
              <SymptomWheel domains={doms} active={hl?.key ?? null} onPick={(dm) => toggle(dm.key, dm.refs.map((r) => r.encounter_id))} />
            </div>
            <div className="ws-sec">
              <h3>Not in the record</h3>
              {a.missing_or_uncertain.length ? <ul className="missing">{a.missing_or_uncertain.map((m, i) => <li key={i}>{m}</li>)}</ul> : <p className="muted small">Nothing important is missing.</p>}
              <p className="small muted">Missing is not the same as absent. Athar never treats an unrecorded symptom as a no.</p>
            </div>
          </div>
          <div className="dock">
            <span className="dock-hint">{hl ? "Showing the visits behind your selection." : "Hover any mark for the quote. Select it to read the full note."}</span>
            {hl && <button className="btn-quiet" onClick={() => setHl(null)}>Show all visits</button>}
          </div>
        </section>

        {/* ------------------------------------------------ right: the assessment */}
        <aside className={`card ws-right cat-${key}`}>
          <p className="ws-kicker">Outcome</p>
          <h2 className="ws-outcome">{CATEGORY_TEXT[key].long}</h2>
          {key === "review" && d.sceptic?.ran && <span className={`pill ${d.sceptic.verdict === "upheld" ? "pill-review" : "pill-insufficient"}`}>{d.sceptic.verdict === "upheld" ? "Upheld by the sceptic" : "Weakened by the sceptic"}</span>}
          <p className="ws-driver">{driverSentence(a)}</p>
          {a.model_score !== null && <p className="ws-score">Pattern score {fmtScore(a.model_score)}{op !== null && <>, review threshold {op}</>}. Not a probability.</p>}
          <ScepticPanel d={d} onQuote={(enc, quote) => setPicked({ enc, quote })} />
          <div className="ws-sec">
            <h3>Clinical signals <span className="muted small">NICE NG73</span></h3>
            <ul className="signals">
              {sigs.map((s: Signal) => (
                <li key={s.key}>
                  <button className={`sig st-${s.state} ${hl?.key === s.key ? "is-on" : ""}`} disabled={!s.encounters.length} onClick={() => toggle(s.key, s.encounters)}>
                    <i className="sig-dot" aria-hidden />
                    <span><b>{s.title}</b><small>{s.detail}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <DecisionPanel key={a.patient_id} id={a.patient_id} dataset={settings.dataset} decision={d.decision} onSaved={(dec) => setD({ ...d, decision: dec })} />
          <div className="ws-actions">
            <button className="btn btn-primary" onClick={() => setExplainOpen(true)}>Full explanation</button>
            {d.synthetic_truth && (reveal
              ? <p className="truth">Synthetic label: <b>{d.synthetic_truth.endometriosis ? "endometriosis" : "no endometriosis"}</b>. Built as “{d.synthetic_truth.scenario_name.replaceAll("_", " ")}”.</p>
              : <button className="link" onClick={() => setReveal(true)}>Reveal synthetic label</button>)}
          </div>
        </aside>
      </div>

      <p className="ws-foot">Decision support only. Athar does not diagnose endometriosis, its scores are not probabilities, and the doctor decides what happens next. All patients are fictional.</p>

      {queueOpen && (
        <div className="drawer-wrap left" onClick={() => setQueueOpen(false)}>
          <aside className="drawer queue-drawer" aria-label="Patient list" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head"><h2>Patients</h2><button className="btn-quiet" onClick={() => setQueueOpen(false)}>Close</button></div>
            <div className="seg" role="tablist" aria-label="Filter by outcome">
              {ORDER.map((k) => <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}><b>{list?.counts[k] ?? "–"}</b>{CATEGORY_TEXT[k].short}</button>)}
              <button role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}><b>{list?.patients.length ?? "–"}</b>All</button>
            </div>
            {list?.patients.some((p) => p.referred !== undefined) && (
              <button className={`chip-toggle ${notReferred ? "is-on" : ""}`} aria-pressed={notReferred} onClick={() => setNotReferred(!notReferred)}>
                Not yet referred to gynaecology <b>{notReferredCount}</b>
              </button>
            )}
            <input className="wl-search" placeholder="Find a patient ID" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a patient ID" />
            <ul className="ql-items">
              {rows.map((p) => (
                <li key={p.patient_id}>
                  <button className={`ql-item cat-${p.category_key} ${id === p.patient_id ? "is-selected" : ""}`} onClick={() => { nav(`/review/${p.patient_id}`); setQueueOpen(false); }}>
                    <span className="wl-rail" aria-hidden />
                    <span className="wl-main"><span className="wl-id">{p.patient_id}</span><span className="wl-meta">{p.age ?? "?"} years, {p.n_encounters} visits{p.relevant_encounters ? `, ${p.relevant_encounters} with pain` : ""}</span></span>
                    {p.category_key === "review" && p.sceptic_verdict ? <span className={`pill ${p.sceptic_verdict === "upheld" ? "pill-review" : "pill-insufficient"}`}>{p.sceptic_verdict === "upheld" ? "Sceptic upheld" : "Sceptic weakened"}</span> : <span className={`pill pill-${p.category_key}`}>{CATEGORY_TEXT[p.category_key].short}</span>}
                  </button>
                </li>
              ))}
              {rows.length === 0 && <li className="muted pad">No patients match.</li>}
            </ul>
          </aside>
        </div>
      )}
      {explainOpen && <ExplainDrawer d={d} onClose={() => setExplainOpen(false)} onPick={(r) => { pick(r.encounter_id, r); setExplainOpen(false); }} />}
    </div>
  );
}
