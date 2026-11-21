import { useEffect, useState } from "react";
import { api } from "../api";

/* Two validated series colours (dataviz validator, light surface): plum = primary, teal = comparison. */
const C1 = "#7a2a87", C2 = "#16907a";
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${Math.round(x * 100)}%`);
const SHORT: Record<string, string> = {
  "PATTERN WARRANTS CLINICAL REVIEW": "Warrants review", "INSUFFICIENT INFORMATION": "Needs more history", "NO NOTABLE PATTERN IDENTIFIED": "No notable pattern",
};

function Tip({ tip }: { tip: { x: number; y: number; text: string } | null }) {
  return tip ? <div className="pm-tip" style={{ left: tip.x + 12, top: tip.y + 12 }}><b>{tip.text}</b></div> : null;
}

/** Flags vs the hidden label as a 2x2 grid. */
function Confusion({ m }: { m: any }) {
  const cells = [
    { k: "tp", label: "Flagged, has endometriosis", v: m.tp, good: true },
    { k: "fn", label: "Not flagged, has endometriosis", v: m.fn, good: false },
    { k: "fp", label: "Flagged, does not have it", v: m.fp, good: false },
    { k: "tn", label: "Not flagged, does not have it", v: m.tn, good: true },
  ];
  const cell = (c: typeof cells[number]) => <div key={c.k} className={`cm2-cell ${c.good ? "good" : "bad"}`} title={c.label}><b>{c.v}</b><small>{c.label}</small></div>;
  return (
    <div className="cm2">
      <span /><span className="cm2-col">Flagged</span><span className="cm2-col">Not flagged</span>
      <span className="cm2-row">Has endometriosis</span>{cell(cells[0])}{cell(cells[1])}
      <span className="cm2-row">Does not have it</span>{cell(cells[2])}{cell(cells[3])}
    </div>
  );
}

function Roc({ pts, op, auc }: { pts: number[][]; op: { fpr: number; tpr: number }; auc: number }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const S = 270, P = 46;
  const X = (v: number) => P + v * (S - P - 10), Y = (v: number) => S - P - v * (S - P - 10);
  const d = pts.map(([f, t], i) => `${i ? "L" : "M"}${X(f)},${Y(t)}`).join(" ");
  return (
    <figure className="chart roc" onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`ROC curve, area under the curve ${auc}`}>
        {[0, 0.5, 1].map((v) => <g key={v}><line x1={X(0)} x2={X(1)} y1={Y(v)} y2={Y(v)} className="ch-grid" /><text x={X(0) - 6} y={Y(v) + 4} textAnchor="end" className="ch-tick">{pct(v)}</text><text x={X(v)} y={Y(0) + 16} textAnchor="middle" className="ch-tick">{pct(v)}</text></g>)}
        <line x1={X(0)} y1={Y(0)} x2={X(1)} y2={Y(1)} className="ch-chance" />
        <path d={d} fill="none" stroke={C1} strokeWidth={2} />
        <circle cx={X(op.fpr)} cy={Y(op.tpr)} r={6} fill={C1} stroke="#fff" strokeWidth={2}
          onMouseMove={(e) => { const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - r.left, y: e.clientY - r.top, text: `Athar's flags: finds ${pct(op.tpr)}, wrongly flags ${pct(op.fpr)}` }); }} />
        <text x={X(op.fpr) + 10} y={Y(op.tpr) + 14} className="ch-label">Athar's flags</text>
        <text x={X(0.5)} y={S - 2} textAnchor="middle" className="ch-axis">Patients without it who are flagged</text>
        <text x={8} y={Y(0.5)} textAnchor="middle" className="ch-axis" transform={`rotate(-90 8 ${Y(0.5)})`}>Patients with it who are flagged</text>
      </svg>
      <Tip tip={tip} />
      <figcaption>The curve shows every trade-off the score allows. Area under the curve: <b>{auc}</b> (1 is perfect, 0.5 is guessing).</figcaption>
    </figure>
  );
}

function ThresholdChart({ tc }: { tc: any }) {
  const [hover, setHover] = useState<any>(null);
  const W = 560, H = 230, L = 44, R = 16, T = 14, B = 34;
  const X = (t: number) => L + t * (W - L - R), Y = (v: number) => T + (1 - v) * (H - T - B);
  const line = (k: string) => tc.points.map((p: any, i: number) => `${i ? "L" : "M"}${X(p.t)},${Y(p[k])}`).join(" ");
  const ch = tc.at_chosen ?? tc.points.reduce((best: any, p: any) => (Math.abs(p.t - tc.chosen) < Math.abs(best.t - tc.chosen) ? p : best), tc.points[0]);
  const tLabel = (t: number) => (t === tc.chosen ? String(tc.chosen) : t.toFixed(2));
  const hv = hover ?? ch;
  return (
    <figure className="chart wide">
      <div className="ch-legend"><span><i style={{ background: C1 }} />Finds patients with it (sensitivity)</span><span><i style={{ background: C2 }} />Leaves others alone (specificity)</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sensitivity and specificity at each threshold on the development set"
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const t = ((e.clientX - r.left) / r.width * W - L) / (W - L - R); const p = tc.points.reduce((b: any, q: any) => (Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b), tc.points[0]); setHover(p); }}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 0.8, 1].map((v) => <g key={v}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} className={v === 0.8 ? "ch-target" : "ch-grid"} /><text x={L - 6} y={Y(v) + 4} textAnchor="end" className="ch-tick">{pct(v)}</text></g>)}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => <text key={t} x={X(t)} y={H - B + 18} textAnchor="middle" className="ch-tick">{t.toFixed(2)}</text>)}
        <text x={W - R} y={Y(0.8) - 5} textAnchor="end" className="ch-label">80% target</text>
        <path d={line("sensitivity")} fill="none" stroke={C1} strokeWidth={2} />
        <path d={line("specificity")} fill="none" stroke={C2} strokeWidth={2} />
        <line x1={X(tc.chosen)} x2={X(tc.chosen)} y1={T} y2={H - B} className="ch-chosen" />
        <text x={X(tc.chosen) + 6} y={T + 10} className="ch-label strong">Chosen: {tc.chosen}</text>
        <line x1={X(hv.t)} x2={X(hv.t)} y1={T} y2={H - B} className="ch-cross" />
        <circle cx={X(hv.t)} cy={Y(hv.sensitivity)} r={4.5} fill={C1} stroke="#fff" strokeWidth={2} />
        <circle cx={X(hv.t)} cy={Y(hv.specificity)} r={4.5} fill={C2} stroke="#fff" strokeWidth={2} />
        <text x={L + (W - L - R) / 2} y={H - 2} textAnchor="middle" className="ch-axis">Score threshold</text>
      </svg>
      <figcaption>At {tLabel(hv.t)}{hv.t === tc.chosen ? " (chosen)" : ""}: finds {pct(hv.sensitivity)} of development patients with endometriosis and leaves {pct(hv.specificity)} of the others alone.</figcaption>
    </figure>
  );
}

/** Horizontal paired bars: one row per measure, two series. */
function PairBars({ rows, names }: { rows: { label: string; a: number | null; b: number | null }[]; names: [string, string] }) {
  return (
    <figure className="chart">
      <div className="ch-legend"><span><i style={{ background: C2 }} />{names[0]}</span><span><i style={{ background: C1 }} />{names[1]}</span></div>
      <div className="pbars">
        {rows.map((r) => (
          <div key={r.label} className="pbar-row">
            <span className="pbar-label">{r.label}</span>
            <div className="pbar-pair">
              {([[r.a, C2, names[0]], [r.b, C1, names[1]]] as [number | null, string, string][]).map(([v, c, n], i) => (
                <div key={i} className="pbar-track" title={`${n}: ${pct(v)}`}>
                  <span className="pbar" style={{ width: `${(v ?? 0) * 100}%`, background: c }} />
                  <span className="pbar-val">{pct(v)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}

function GroupBars({ groups }: { groups: Record<string, any> }) {
  return (
    <div className="gbars">
      {Object.entries(groups).map(([k, g]) => (
        <div key={k} className="gbar-row" title={`${k}: ${g.n} patients, ${g.label_positive} with endometriosis`}>
          <span className="pbar-label">{k}<small>{g.n} patients, {g.label_positive} with it</small></span>
          <div className="pbar-pair">
            <div className="pbar-track"><span className="pbar" style={{ width: `${(g.sensitivity ?? 0) * 100}%`, background: C1 }} /><span className="pbar-val">{g.sensitivity === null ? "n/a" : pct(g.sensitivity)}</span></div>
            <div className="pbar-track"><span className="pbar" style={{ width: `${(g.specificity ?? 0) * 100}%`, background: C2 }} /><span className="pbar-val">{g.specificity === null ? "n/a" : pct(g.specificity)}</span></div>
          </div>
        </div>
      ))}
    </div>
  );
}

type Est = { value: number | null; ci95: [number | null, number | null] };
const range = (e: Est, asPct = true) => (e.ci95[0] === null ? "" : asPct ? `${pct(e.ci95[0])} to ${pct(e.ci95[1])}` : `${e.ci95[0]} to ${e.ci95[1]}`);
/** "better" / "worse" only when the paired 95% range of the difference excludes zero. */
const direction = (d: Est) => (d.ci95[0] !== null && d.ci95[0] > 0 ? "better" : d.ci95[1] !== null && d.ci95[1] < 0 ? "worse" : "same");

const RULE_PLAIN: Record<string, string> = {
  rule_a: "Flag anyone with relevant pain at two or more separate visits, including at least one key symptom: painful periods, pelvic pain, pain with sex or painful bowel movements.",
  rule_b: "Rule A, but only if the notes also show pain that follows the cycle, pain that carried on after treatment was started, or pain that carried on after a normal test.",
};

function RulesVsAI({ c }: { c: any }) {
  const M = c.methods, D = c.athar_minus_rule;
  const order = ["athar", ...Object.keys(D)];
  const label = (k: string) => (k === "athar" ? "Athar" : M[k].name.replace("Guideline rule", "Rule"));
  const cols: [string, string, boolean][] = [
    ["sensitivity", "Finds patients with it", true], ["specificity", "Leaves others alone", true], ["precision", "Flags that are right", true],
    ["flagged", "Patients flagged", false], ["false_positives", "Flagged wrongly", false],
  ];
  const verdict = (k: string) => {
    const d = D[k], a = M.athar, r = M[k], name = label(k);
    const find = direction(d.sensitivity);
    const first = find === "same"
      ? `${name} and Athar find about the same share of patients with endometriosis (${pct(r.sensitivity.value)} and ${pct(a.sensitivity.value)}); the difference is within the uncertainty.`
      : find === "better"
        ? `Athar finds more patients with endometriosis than ${name} (${pct(a.sensitivity.value)} vs ${pct(r.sensitivity.value)}).`
        : `${name} finds more patients with endometriosis than Athar (${pct(r.sensitivity.value)} vs ${pct(a.sensitivity.value)}).`;
    // difference is Athar minus rule, so a "worse" (negative) range here means Athar has FEWER false positives
    const fp = direction(d.false_positives);
    const second = fp === "worse"
      ? `${find === "worse" ? "But " : ""}${name} flags ${r.flagged.value} of ${c.n} patients, ${r.false_positives.value} of them wrongly; Athar flags ${a.flagged.value}, with ${a.false_positives.value} wrong. That is about ${-d.false_positives.value} fewer unnecessary reviews with Athar.`
      : fp === "better"
        ? `Athar wrongly flags more patients (${a.false_positives.value} vs ${r.false_positives.value}).`
        : `Both wrongly flag a similar number of patients (${a.false_positives.value} and ${r.false_positives.value}).`;
    return `${first} ${second}`;
  };
  return (
    <section className="card perf-block">
      <h2>Does the AI beat simple rules?</h2>
      <p>A fair test of the AI is whether it does better than simply applying the guideline checklist to the same notes. We took exactly the symptoms Athar's reader found in each record and applied two simple rules to them, with no model involved:</p>
      <ul className="rules-list">
        {Object.keys(D).map((k) => <li key={k}><b>{label(k)}.</b> {RULE_PLAIN[k] ?? M[k].definition}</li>)}
      </ul>
      <div className="table-scroll">
        <table className="simple rules-table">
          <thead><tr><th scope="col">Out of {c.n} patients ({c.label_positive} with endometriosis)</th>{cols.map(([k, l]) => <th key={k} scope="col">{l}</th>)}</tr></thead>
          <tbody>{order.map((k) => (
            <tr key={k} className={k === "athar" ? "is-chosen" : ""}>
              <th scope="row">{label(k)}</th>
              {cols.map(([m, , isPct]) => <td key={m}>{isPct ? pct(M[k][m].value) : M[k][m].value}<small>{range(M[k][m], isPct)}</small></td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <ul className="rules-verdict">{Object.keys(D).map((k) => <li key={k}>{verdict(k)}</li>)}</ul>
      <p className="small muted">The small numbers are 95% ranges: we re-drew the {c.n} patients {c.bootstrap.resamples.toLocaleString()} times at random (fixed seed) and scored all three methods on each draw. We only call one method better when the range for the difference between them stays on one side of zero.
        {c.athar_auc && <> Athar's score has an area under the curve of {c.athar_auc.value} ({range(c.athar_auc, false)}); the rules give a plain yes or no, so they have no curve.</>} These are synthetic patients, so this comparison says nothing yet about how either approach would do on real records.</p>
    </section>
  );
}

const SCENARIO_PLAIN: Record<string, string> = {
  routine_unrelated: "Silent record: only routine, unrelated visits",
  isolated_symptom: "One isolated symptom, never repeated",
  insufficient_records: "Sparse record: too few visits",
  dysmenorrhoea_only: "Period pain only",
  overlapping_conditions: "Symptoms shared with another condition",
  pelvic_pain_no_menstrual_link: "Pelvic pain recorded as not linked to periods",
  cyclical_pelvic_pain: "Cyclical pelvic pain",
  repeated_inconclusive: "Repeated visits, tests normal",
  inconsistent_documentation: "Inconsistent notes",
  gi_non_menstrual: "Bowel symptoms labelled as IBS",
  varied_terminology: "Unusual wording in notes",
};
const scenarioName = (key: string) => {
  const [sc, sub] = key.split(" / ");
  const base = SCENARIO_PLAIN[sc] ?? sc.replaceAll("_", " ");
  return sc === "overlapping_conditions" && sub ? `${base} (${sub.replace("overlap_", "").replaceAll("_", " ")})` : base;
};

const SILENT = new Set(["routine_unrelated", "isolated_symptom", "insufficient_records"]);

function Misses({ d }: { d: any }) {
  const bi = d.built_without_visible_pattern, gm = d.genuine_misses;
  // one row per plain-language scenario, split into "silent or too thin" and "looked like another condition"
  const groups: Record<"silent" | "lookalike", Record<string, number>> = { silent: {}, lookalike: {} };
  Object.entries(bi.by_scenario as Record<string, number>).forEach(([k, n]) => {
    const g = SILENT.has(k.split(" / ")[0]) ? groups.silent : groups.lookalike;
    const name = scenarioName(k); g[name] = (g[name] ?? 0) + n;
  });
  const total = (g: Record<string, number>) => Object.values(g).reduce((x, y) => x + y, 0);
  const nSilent = total(groups.silent), nLook = total(groups.lookalike);
  const list = (g: Record<string, number>) => (
    <table className="simple"><tbody>{Object.entries(g).sort((x, y) => y[1] - x[1]).map(([k, n]) => <tr key={k}><td>{k}</td><td className="num">{n}</td></tr>)}</tbody></table>
  );
  return (
    <section className="card perf-block">
      <h2>What Athar misses, and why</h2>
      <p>{d.missed} of the {d.label_positive} patients with endometriosis were not flagged. They fall into three groups. In <b>{nSilent}</b>, the record was silent or too thin to show a pattern. In <b>{nLook}</b>, the notes showed a pattern that looked like another condition, which is what these records were built to show. <b>{gm.n}</b> {gm.n === 1 ? "is a genuine miss" : "are genuine misses"}: the pattern was in the notes and Athar did not flag it.</p>
      <div className="miss-split" role="img" aria-label={`${nSilent} silent or too thin, ${nLook} looked like another condition, ${gm.n} genuine misses`}>
        {nSilent > 0 && <span className="ms-silent" style={{ flex: nSilent }}>{nSilent} silent or too thin</span>}
        {nLook > 0 && <span className="ms-lookalike" style={{ flex: Math.max(nLook, 4) }}>{nLook} looked like another condition</span>}
        {gm.n > 0 && <span className="ms-genuine" style={{ flex: Math.max(gm.n, 1.6) }}>{gm.n}</span>}
      </div>
      <div className="two">
        <div>
          <h3>Silent or too thin ({nSilent})</h3>
          {list(groups.silent)}
          <h3 className="mt">Pattern looked like another condition ({nLook})</h3>
          {list(groups.lookalike)}
          <p className="small muted">Across these {bi.n}, Athar's outcome was "no notable pattern" for {bi.by_category["NO NOTABLE PATTERN IDENTIFIED"] ?? 0} and "needs more history" for {bi.by_category["INSUFFICIENT INFORMATION"] ?? 0}. {bi.by_score_band["At or above the threshold"] ?? 0} scored above the threshold but were held back by a safety rule (for example pain at only one visit, or only vague symptoms) or sent for more history.</p>
        </div>
        <div>
          <h3>Genuine miss{gm.n === 1 ? "" : "es"} ({gm.n})</h3>
          {gm.cases.length === 0 ? <p className="small muted">None: every patient whose notes showed a reviewable pattern was flagged.</p> : gm.cases.map((c: any) => (
            <div key={c.id} className="miss-case">
              <div className="mc-head"><b>{c.id}</b><span>{scenarioName(`${c.scenario} / ${c.subtype}`)}</span></div>
              <p className="small">Outcome: {SHORT[c.category] ?? c.category}. {c.why_not_flagged.join("; ")}: score {c.score} against a threshold of {d.threshold}, with pain at {c.relevant_visits} visits.</p>
              <ul className="small">
                {c.pattern_gaps.map((g: string) => <li key={g}>{g}</li>)}
                {c.model_lowered_by.length > 0 && <li>Pulled the score down: {c.model_lowered_by.join(", ")}</li>}
                {c.record_gaps.map((g: string) => <li key={g} className="muted">{g}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="miss-callout">
        <b>A tool that reads records can't find women whose records are silent.</b>
        <p>If pain was never raised, never written down, or written once and never again, there is no pattern in the notes for Athar or anyone else to find. That is why a patient self-check route is planned, so women whose symptoms never reached their notes have another way to be noticed.</p>
      </div>
    </section>
  );
}

export default function Performance() {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.evaluation().then(setR).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="perf"><p className="error">{err}</p></div>;
  if (!r) return <div className="perf"><p className="muted">Loading results…</p></div>;

  const B = r.B_hidden_label.all_patients;
  const A = r.A_constructed_scenarios;
  const cats = Object.keys(A.confusion_matrix_expected_rows_predicted_cols);
  const maxCell = Math.max(...cats.flatMap((e) => cats.map((p) => A.confusion_matrix_expected_rows_predicted_cols[e][p])));
  const m = r.model ?? {};
  const cmp = r.extractor_comparison ?? null;
  const kw = cmp ? Object.entries(cmp).find(([k]) => k.startsWith("lexicon"))?.[1] as any : null;
  const llmE = cmp ? Object.entries(cmp).find(([k]) => k.startsWith("llm"))?.[1] as any : null;
  const llmName = r.extractor?.startsWith("llm:") ? r.extractor.slice(4).split("/").pop() : "LLM";
  const sc = r.sceptic;
  const bv = sc?.by_verdict ?? {};
  const reviewed = (bv.upheld?.n ?? 0) + (bv.weakened?.n ?? 0) + (bv.challenged?.n ?? 0);
  const weakenedN = (bv.weakened?.n ?? 0) + (bv.challenged?.n ?? 0), weakenedPos = (bv.weakened?.label_positive ?? 0) + (bv.challenged?.label_positive ?? 0);
  const total = r.n_patients, positives = B.tp + B.fn;

  return (
    <div className="perf">
      <header className="perf-head">
        <h1>How Athar performs</h1>
        <p className="lede">Tested on {total} synthetic patients that were never used while building it. {positives} of them have endometriosis according to a hidden label set before their notes were written. Pipeline tested: {(r.pipeline ?? "LLM reader, model and rules").replace("sceptic agent", "sceptic reviewer")}.</p>
      </header>

      <section className="perf-metrics">
        <div><b>{pct(B.sensitivity)}</b><p>of patients with endometriosis were flagged <small>Sensitivity: {B.tp} of {positives}</small></p></div>
        <div><b>{pct(B.specificity)}</b><p>of patients without it were left alone <small>Specificity: {B.tn} of {B.tn + B.fp}</small></p></div>
        <div><b>{pct(B.precision)}</b><p>of flags were correct <small>Precision: {B.tp} of {B.tp + B.fp}</small></p></div>
        <div><b>{r.B_hidden_label.model_score_auc}</b><p>area under the curve for the score <small>{r.C_rule_baselines?.athar_auc ? `95% range ${range(r.C_rule_baselines.athar_auc, false)}. ` : ""}Published symptom-based models: about 0.65 to 0.85</small></p></div>
      </section>

      <section className="card perf-block two">
        <div>
          <h2>Every patient, by outcome</h2>
          <p className="muted small">"Needs more history" counts as not flagged.</p>
          <Confusion m={B} />
        </div>
        {r.roc_eval?.length > 0 && <Roc pts={r.roc_eval} op={{ fpr: B.false_positive_rate, tpr: B.sensitivity }} auc={r.B_hidden_label.model_score_auc} />}
      </section>

      {r.C_rule_baselines && <RulesVsAI c={r.C_rule_baselines} />}

      {r.D_misses && <Misses d={r.D_misses} />}

      {r.threshold_curve && (
        <section className="card perf-block">
          <h2>Why the threshold is {r.threshold_curve.chosen}</h2>
          <p>Missing a patient costs more than an extra review, so the threshold was chosen to favour catching cases: it is the <b>highest score that still finds at least 80% of patients with endometriosis</b> in the {r.threshold_curve.n_dev} development patients, measured on patients each model had not seen (5-fold cross-validation).{r.threshold_curve.at_chosen && <> At exactly {r.threshold_curve.chosen} it finds <b>{(r.threshold_curve.at_chosen.sensitivity * 100).toFixed(1)}%</b> of development patients with endometriosis and leaves {(r.threshold_curve.at_chosen.specificity * 100).toFixed(1)}% of the others alone.</>} Lower would flag more healthy patients; higher would miss more. Hover the chart to see the trade-off at any threshold.</p>
          <div className="two-60">
            <ThresholdChart tc={r.threshold_curve} />
            <div className="perf-aside">
              <h3>Why {String(m.chosen_model ?? "").replaceAll("_", " ")}</h3>
              <p className="small muted">Three models were compared on the development set. The one with the best cross-validated area under the curve was kept.</p>
              <table className="simple">
                <thead><tr><th>Model</th><th>Area under curve</th></tr></thead>
                <tbody>{Object.entries(m.candidates ?? {}).map(([k, v]: any) => <tr key={k} className={k === m.chosen_model ? "is-chosen" : ""}><td>{k.replaceAll("_", " ")}</td><td>{v.cv_auc}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      <section className="card perf-block two">
        <div>
          <h2>Does the LLM reader help?</h2>
          <p className="small">The same model and rules, with notes read either by keyword rules or by the LLM ({llmName}). Symptom recall is how many symptoms written in the notes were found.</p>
          {kw && llmE ? (
            <PairBars names={["Keyword rules", "LLM reader"]} rows={[
              { label: "Symptoms found in notes", a: kw.symptom_recall, b: llmE.symptom_recall },
              { label: "Patients with it flagged", a: kw.sensitivity, b: llmE.sensitivity },
              { label: "Patients without it left alone", a: kw.specificity, b: llmE.specificity },
            ]} />
          ) : <p className="muted small">Run <code>py -m athar.evaluation.evaluate --compare</code> to add this comparison.</p>}
        </div>
        <div>
          <h2>What the sceptic reviewer adds</h2>
          {reviewed ? (
            <>
              <p className="small">The sceptic reviewer checked all {sc.flags_total} flags. It downgraded {sc.downgraded}, but its verdict separates strong flags from weak ones:</p>
              <div className="verdict-bars">
                {[["Upheld", bv.upheld?.n ?? 0, bv.upheld?.label_positive ?? 0], ["Weakened", weakenedN, weakenedPos]].map(([name, n, pos]: any) => (
                  <div key={name} className="vb-row" title={`${name}: ${pos} of ${n} have endometriosis`}>
                    <span className="pbar-label">{name}<small>{n} flags</small></span>
                    <div className="vb-track">
                      <span className="vb-pos" style={{ width: `${n ? (pos / n) * 100 : 0}%` }}>{n ? pct(pos / n) : ""}</span>
                      <span className="vb-neg" style={{ width: `${n ? ((n - pos) / n) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
                <div className="ch-legend"><span><i style={{ background: C1 }} />Has endometriosis</span><span><i style={{ background: "#d9cbe0" }} />Does not</span></div>
              </div>
              <p className="small muted">Patient review shows upheld flags first. Downgrades happen only when a quote-verified, confirmed alternative explanation exists or a corrected misread changes the outcome; none did in this set.</p>
            </>
          ) : <p className="muted small">Run <code>py -m athar.agents.sceptic --dataset eval</code>, then the evaluation, to add this result.</p>}
        </div>
      </section>

      {r.documentation && (
        <section className="card perf-block">
          <h2>When the record is thin</h2>
          <p>Athar can only find what was written down. With fewer documented visits it flags fewer patients: a short record rarely shows recurrence. That is why thin records go to "needs more history" instead of being cleared.</p>
          <div className="ch-legend"><span><i style={{ background: C1 }} />Patients with it flagged</span><span><i style={{ background: C2 }} />Patients without it left alone</span></div>
          <div className="two">
            <div><h3>By length of record</h3><GroupBars groups={r.documentation.by_record_length} /></div>
            <div><h3>By how often notes record cycle link, severity or treatment response</h3><GroupBars groups={r.documentation.by_note_completeness} /><p className="small muted">Small groups: read the first two rows with caution.</p></div>
          </div>
        </section>
      )}

      <section className="card perf-block two">
        <div>
          <h2>Built-in scenarios</h2>
          <p className="small"><b>This compares Athar with what each scenario was built to show, not with the hidden label.</b> Some scenarios were deliberately built to look like a pattern in patients who do not have endometriosis, so "warrants review" here does not always mean the patient has it.</p>
          <p className="small">Each synthetic patient was built to show a documented pattern, too little history, or no notable pattern. Rows are what was built, columns are Athar's outcome.</p>
          <table className="confusion">
            <thead><tr><th scope="col">Built to show</th>{cats.map((c) => <th key={c} scope="col">{SHORT[c]}</th>)}</tr></thead>
            <tbody>{cats.map((e) => (
              <tr key={e}><th scope="row">{SHORT[e]}</th>{cats.map((p) => {
                const v = A.confusion_matrix_expected_rows_predicted_cols[e][p];
                return <td key={p} className={e === p ? "diag" : ""} style={{ ["--a" as any]: v / maxCell }}>{v}</td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
        <div>
          <h2>How well the notes were read</h2>
          <dl className="mini-metrics">
            <div><dt>Symptoms found</dt><dd>{pct(r.extraction_quality.symptom_recall)}</dd></div>
            <div><dt>Findings that were right</dt><dd>{pct(r.extraction_quality.symptom_precision)}</dd></div>
            <div><dt>Present, denied or uncertain correct</dt><dd>{pct(r.extraction_quality.status_accuracy_when_found)}</dd></div>
            <div><dt>Link to periods correct</dt><dd>{pct(r.extraction_quality.menstrual_link_accuracy_when_found)}</dd></div>
          </dl>
          <p className="small muted">Scored against what the generator actually wrote into each note.</p>
        </div>
      </section>

      <p className="perf-caveat">{r.caveat}</p>
    </div>
  );
}
