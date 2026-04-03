/**
 * PROACT Enrollment & Operations Dashboard — v2
 * ================================================
 *
 * STATE ARCHITECTURE
 * ------------------
 * All counts live in a single `counts` object. Key design decisions:
 *
 * UPSTREAM FUNNEL (accrual):
 *   invited → scheduled → ccta
 *   Each stage holds current occupancy (people in that stage right now).
 *   Advancing someone atomically decrements source and increments destination.
 *
 * POST-CCTA BRANCH (two parallel study paths — neither is attrition):
 *   ccta resolves into either:
 *     proact1   — PROACT 1 participants (no plaque, randomized to disclosure arm)
 *     proact2   — PROACT 2 participants (plaque-positive)
 *   proact1 and proact2 are CUMULATIVE totals (ever reached that path).
 *   They do NOT decrement when someone moves downstream within PROACT 2.
 *
 * PROACT 2 SUB-PIPELINE (tracked with separate counters, all subsets of proact2):
 *   proact2       — total ever enrolled in PROACT 2
 *   randomized    — subset of proact2 who have been randomized (≤ proact2)
 *   completedCCTA — subset of randomized who completed final CCTA (≤ randomized)
 *   attrited      — subset of randomized who are LTFU/dropped (≤ randomized)
 *   "Active follow-up" is derived: randomized − completedCCTA − attrited
 *
 * WHY THIS DESIGN:
 *   - proact2 never decrements (it's a realized enrollment milestone)
 *   - randomized, completedCCTA, attrited are additive sub-counters
 *   - Guards enforce: randomized ≤ proact2, completedCCTA+attrited ≤ randomized
 *   - Projections use only upstream occupancy (invited/scheduled/ccta)
 *   - Downstream projections (→ randomized, → completedCCTA) are separate
 *
 * DENOMINATORS:
 *   - PROACT 2 proportion: proact2 / (proact1 + proact2) — resolved post-CCTA
 *   - Attrition %: attrited / randomized
 *   - Final CCTA completion %: completedCCTA / randomized
 *   - "Active" follow-up: randomized − completedCCTA − attrited
 *
 * PERSISTENCE: localStorage key "proact_v2_state"
 * UNDO: full snapshot stack (up to 50 steps)
 */

import { useState, useEffect, useCallback, useRef } from "react";

// ─── Constants & defaults ────────────────────────────────────────────────────

const STORAGE_KEY = "proact_v2_state";
const MAX_LOG = 60;
const MAX_HISTORY = 50;

const DEFAULT_ASSUMPTIONS = {
  // Upstream accrual
  inviteToScheduled:  0.15,
  scheduledToCCTA:    0.90,
  cctaToProact2:      0.50,   // plaque prevalence / PROACT 2 branch rate
  // Downstream (PROACT 2 sub-pipeline) — optional projections
  proact2ToRandomized:    0.95,
  randomizedToCompleted:  0.85,
  randomizedAttrition:    0.10,
};

const DEFAULT_COUNTS = {
  // Upstream funnel occupancy
  invited:    0,
  scheduled:  0,
  ccta:       0,
  // Post-CCTA study paths (cumulative, never decrement except data correction)
  proact1:    0,
  proact2:    0,
  // PROACT 2 sub-pipeline (all subsets of proact2 — additive counters)
  randomized:    0,
  completedCCTA: 0,
  attrited:      0,
  // Exit without study path
  noPlaque:   0,   // CCTA negative, not eligible for either study path
  declined:   0,   // Declined/lost after scheduling (never reached CCTA)
};

const DEFAULT_TRANSITIONS = {
  invitedToScheduled:   0,
  scheduledToCCTA:      0,
  scheduledToDeclined:  0,
  cctaToProact1:        0,
  cctaToProact2:        0,
  cctaToNoPlaque:       0,
  proact2ToRandomized:  0,
  randomizedToCompleted:0,
  randomizedToAttrited: 0,
};

const GOALS_DEFAULT = { randomized: 220 };

// Demo state for quick preview
const DEMO = {
  counts: {
    invited: 2800, scheduled: 180, ccta: 42,
    proact1: 198, proact2: 74,
    randomized: 68, completedCCTA: 31, attrited: 4,
    noPlaque: 198, declined: 18,
  },
  transitions: {
    invitedToScheduled: 280, scheduledToCCTA: 230, scheduledToDeclined: 18,
    cctaToProact1: 198, cctaToProact2: 74, cctaToNoPlaque: 198,
    proact2ToRandomized: 68, randomizedToCompleted: 31, randomizedToAttrited: 4,
  },
};

// ─── Styling tokens ───────────────────────────────────────────────────────────

const C = {
  bg:        "#f4f6f9",
  surface:   "#ffffff",
  border:    "#dde1e8",
  borderAcc: "#b8c0cc",
  text:      "#1a202c",
  textMid:   "#4a5568",
  textMute:  "#8898aa",
  // Stage accents
  invited:   "#4361ee",
  scheduled: "#3a86ff",
  ccta:      "#0096c7",
  proact1:   "#7209b7",
  proact2:   "#2d9e44",
  random:    "#1b7f3e",
  completed: "#155d2e",
  attrited:  "#c0392b",
  noPlaque:  "#718096",
  declined:  "#a0aec0",
  // KPI
  kpiActual:  "#2d9e44",
  kpiProj:    "#3a86ff",
  kpiTotal:   "#4361ee",
  kpiWarn:    "#d97706",
};

const mono = "'IBM Plex Mono', 'Fira Code', monospace";
const sans = "'IBM Plex Sans', 'Inter', system-ui, sans-serif";

// ─── Utility ─────────────────────────────────────────────────────────────────

const fmt1 = n => (typeof n === "number" ? (n % 1 === 0 ? n.toString() : n.toFixed(1)) : n);
const fmtPct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—");
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const ts = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ─── Projection engine ────────────────────────────────────────────────────────

function computeUpstreamProjection(counts, assumptions, overrideCounts = null) {
  const c = overrideCounts || counts;
  const { inviteToScheduled: p1, scheduledToCCTA: p2, cctaToProact2: p3 } = assumptions;
  const fromInvited   = c.invited   * p1 * p2 * p3;
  const fromScheduled = c.scheduled * p2 * p3;
  const fromCCTA      = c.ccta      * p3;
  const projAdditional = fromInvited + fromScheduled + fromCCTA;
  return { fromInvited, fromScheduled, fromCCTA, projAdditional };
}

function computeDownstreamProjection(counts, assumptions) {
  const { proact2ToRandomized: r, randomizedToCompleted: c, randomizedAttrition: a } = assumptions;
  // Pending randomization = proact2 total − already randomized
  const pendingRand    = Math.max(0, counts.proact2 - counts.randomized);
  const projNewRand    = pendingRand * r;
  const totalRandProj  = counts.randomized + projNewRand;
  // Active follow-up = randomized − completed − attrited
  const activeFollowup = Math.max(0, counts.randomized - counts.completedCCTA - counts.attrited);
  const projCompleted  = counts.completedCCTA + activeFollowup * c;
  const projAttrited   = counts.attrited + activeFollowup * a;
  return { pendingRand, projNewRand, totalRandProj, activeFollowup, projCompleted, projAttrited };
}

function computeObserved(transitions) {
  const { scheduledToCCTA, scheduledToDeclined, cctaToProact2,
          cctaToProact1, cctaToNoPlaque, randomizedToCompleted, randomizedToAttrited,
          proact2ToRandomized } = transitions;
  const schedResolved = scheduledToCCTA + scheduledToDeclined;
  const cctaResolved  = cctaToProact1 + cctaToProact2 + cctaToNoPlaque;
  const randResolved  = randomizedToCompleted + randomizedToAttrited;
  return {
    schedToCCTA:  schedResolved > 0 ? scheduledToCCTA / schedResolved : null,
    cctaToP2:     cctaResolved > 0  ? cctaToProact2 / cctaResolved   : null,
    p2ToRand:     transitions.proact2ToRandomized > 0 ? proact2ToRandomized / (transitions.proact2ToRandomized + Math.max(0, transitions.cctaToProact2 - transitions.proact2ToRandomized)) : null,
    randToComp:   randResolved > 0  ? randomizedToCompleted / randResolved : null,
  };
}

// ─── Small UI components ─────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color, badge, small }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderTop: `3px solid ${color || C.kpiActual}`,
      borderRadius: 8, padding: small ? "12px 14px" : "16px 18px",
      flex: 1, minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, letterSpacing: "0.12em", marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: small ? 22 : 28, fontWeight: 700, color: color || C.text, fontFamily: mono, lineHeight: 1, marginBottom: 3 }}>
        {fmt1(value)}
      </div>
      {sub && <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono }}>{sub}</div>}
      {badge && (
        <div style={{ marginTop: 6, display: "inline-block", background: `${color}18`, border: `1px solid ${color}44`, borderRadius: 4, padding: "2px 7px", fontSize: 10, color, fontFamily: mono }}>
          {badge}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children, color }) {
  return (
    <div style={{
      fontSize: 10, color: color || C.textMute, fontFamily: mono,
      letterSpacing: "0.14em", textTransform: "uppercase",
      borderBottom: `1px solid ${C.border}`, paddingBottom: 7, marginBottom: 14,
    }}>{children}</div>
  );
}

function Pill({ children, color }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 4,
      background: `${color}18`, border: `1px solid ${color}44`,
      fontSize: 10, color, fontFamily: mono,
    }}>{children}</span>
  );
}

// Stepable +/− button
function StepBtn({ onClick, disabled, red, children }) {
  return (
    <button onClick={() => !disabled && onClick()} disabled={disabled} style={{
      width: 26, height: 26, borderRadius: 4, border: `1px solid ${disabled ? C.border : red ? "#fca5a5" : "#b8c0cc"}`,
      background: disabled ? C.bg : red ? "#fff1f1" : "#f0f4ff",
      color: disabled ? C.textMute : red ? C.attrited : C.invited,
      fontSize: 15, fontFamily: mono, cursor: disabled ? "not-allowed" : "pointer",
      display: "flex", alignItems: "center", justifyContent: "center",
      transition: "all 0.1s", userSelect: "none",
    }}>{children}</button>
  );
}

// Inline numeric field for bulk editing
function InlineEdit({ value, onSave, min = 0, max = 99999 }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const ref = useRef();

  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  const commit = () => {
    const n = parseInt(draft);
    if (!isNaN(n) && n >= min && n <= max) onSave(clamp(n, min, max));
    setEditing(false);
  };

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} style={{
        background: "transparent", border: "1px dashed transparent", borderRadius: 4,
        padding: "1px 4px", fontFamily: mono, fontSize: 13, color: C.text,
        cursor: "text", minWidth: 40, textAlign: "right",
        transition: "border-color 0.15s",
      }}
        onMouseEnter={e => e.currentTarget.style.borderColor = C.borderAcc}
        onMouseLeave={e => e.currentTarget.style.borderColor = "transparent"}
        title="Click to edit"
      >{value}</button>
    );
  }
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
      <input ref={ref} type="number" value={draft} min={min} max={max}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{
          width: 64, padding: "2px 6px", fontFamily: mono, fontSize: 13,
          border: `1px solid ${C.invited}`, borderRadius: 4, outline: "none",
          background: "#f0f4ff", color: C.text,
        }}
      />
      <button onClick={commit} style={{ padding: "2px 7px", background: C.invited, color: "#fff", border: "none", borderRadius: 4, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>✓</button>
      <button onClick={() => setEditing(false)} style={{ padding: "2px 6px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 11, fontFamily: mono, cursor: "pointer", color: C.textMute }}>✕</button>
    </div>
  );
}

function Tab({ id, label, active, onClick, badge }) {
  return (
    <button onClick={() => onClick(id)} style={{
      padding: "7px 14px", borderRadius: "6px 6px 0 0", fontFamily: mono, fontSize: 12,
      background: active ? C.surface : "transparent",
      border: active ? `1px solid ${C.border}` : "1px solid transparent",
      borderBottom: active ? `1px solid ${C.surface}` : "1px solid transparent",
      color: active ? C.invited : C.textMute,
      cursor: "pointer", transition: "all 0.1s", whiteSpace: "nowrap",
      marginBottom: active ? -1 : 0,
    }}>
      {label}
      {badge !== undefined && (
        <span style={{ marginLeft: 5, background: `${C.invited}20`, color: C.invited, borderRadius: 10, padding: "1px 6px", fontSize: 10 }}>{badge}</span>
      )}
    </button>
  );
}

// ─── Funnel row component ─────────────────────────────────────────────────────

function FunnelRow({ label, sublabel, color, count, yieldPer, projContrib,
  onPlus, onMinus, plusDisabled, minusDisabled,
  onDirectEdit, advance, advanceLabel, advanceDisabled,
  isFinal, isDead, isSubset, noProj }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "10px 14px", borderRadius: 7, marginBottom: 5,
      background: isSubset ? "#f8f9fc" : C.surface,
      border: `1px solid ${C.border}`,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ flex: "0 0 200px" }}>
        <div style={{ fontSize: 13, color: C.text, fontFamily: mono, fontWeight: 500 }}>{label}</div>
        {sublabel && <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>{sublabel}</div>}
      </div>

      {/* Count: clickable for direct edit */}
      <div style={{ flex: "0 0 72px", textAlign: "right" }}>
        {onDirectEdit ? (
          <InlineEdit value={count} onSave={onDirectEdit} />
        ) : (
          <span style={{ fontSize: 20, fontWeight: 700, color, fontFamily: mono }}>{count}</span>
        )}
      </div>

      {/* +/− */}
      <div style={{ display: "flex", gap: 4 }}>
        <StepBtn onClick={onMinus} disabled={minusDisabled} red>{"-"}</StepBtn>
        <StepBtn onClick={onPlus}  disabled={plusDisabled}>{"+"}</StepBtn>
      </div>

      {/* Advance button */}
      {advance && (
        <button onClick={advance} disabled={advanceDisabled} style={{
          padding: "4px 10px", borderRadius: 4, fontSize: 11, fontFamily: mono,
          background: advanceDisabled ? "transparent" : "#e8f4ff",
          border: `1px solid ${advanceDisabled ? C.border : C.kpiProj}`,
          color: advanceDisabled ? C.textMute : C.kpiProj,
          cursor: advanceDisabled ? "not-allowed" : "pointer", whiteSpace: "nowrap",
        }}>{advanceLabel}</button>
      )}

      {/* Projection contribution */}
      {!noProj && (
        <div style={{ marginLeft: "auto", textAlign: "right", minWidth: 90 }}>
          {isFinal ? (
            <Pill color={color}>realized</Pill>
          ) : isDead ? (
            <Pill color={C.textMute}>exit</Pill>
          ) : count > 0 && yieldPer !== undefined ? (
            <div>
              <div style={{ fontSize: 11, color: C.textMid, fontFamily: mono }}>→ {(projContrib ?? 0).toFixed(2)} proj P2</div>
              <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>×{yieldPer.toFixed(4)}/person</div>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono }}>—</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Rate input ───────────────────────────────────────────────────────────────

function RateInput({ label, value, onChange }) {
  const [raw, setRaw] = useState((value * 100).toFixed(0));
  useEffect(() => setRaw((value * 100).toFixed(0)), [value]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
      <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono, flex: 1 }}>{label}</span>
      <input type="number" min={1} max={99} value={raw}
        onChange={e => { setRaw(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n) && n > 0 && n < 100) onChange(n / 100); }}
        style={{ width: 52, background: "#f0f4ff", border: `1px solid ${C.border}`, color: C.text, padding: "4px 6px", borderRadius: 4, fontSize: 12, fontFamily: mono, textAlign: "right" }}
      />
      <span style={{ fontSize: 12, color: C.textMute, fontFamily: mono }}>%</span>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function PROACTDashboardV2() {
  // ── State ──
  const [counts,      setCounts]      = useState({ ...DEFAULT_COUNTS });
  const [transitions, setTransitions] = useState({ ...DEFAULT_TRANSITIONS });
  const [assumptions, setAssumptions] = useState({ ...DEFAULT_ASSUMPTIONS });
  const [log,         setLog]         = useState([]);
  const [history,     setHistory]     = useState([]);
  const [goals,       setGoals]       = useState({ ...GOALS_DEFAULT });
  const [goalInput,   setGoalInput]   = useState(String(GOALS_DEFAULT.randomized));
  const [scenario,    setScenario]    = useState(null);
  const [scenarioInput, setScenarioInput] = useState({ field: "scheduled", delta: 10 });
  const [activeTab,   setActiveTab]   = useState("tracker");
  const [useObserved, setUseObserved] = useState(false);
  const [savedAt,     setSavedAt]     = useState(null);
  const [importText,  setImportText]  = useState("");
  const [importError, setImportError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  // ── Restore from localStorage ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.counts)      setCounts(s.counts);
        if (s.transitions) setTransitions(s.transitions);
        if (s.assumptions) setAssumptions(s.assumptions);
        if (s.log)         setLog(s.log);
        if (s.goals)       { setGoals(s.goals); setGoalInput(String(s.goals.randomized ?? 220)); }
      }
    } catch {}
  }, []);

  // ── Persist to localStorage ──
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ counts, transitions, assumptions, log, goals }));
      setSavedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    } catch {}
  }, [counts, transitions, assumptions, log, goals]);

  // ── Helpers ──
  const snap = useCallback(() => ({ counts: { ...counts }, transitions: { ...transitions }, log: [...log] }), [counts, transitions, log]);

  const pushHistory = useCallback((snapshot) => {
    setHistory(h => [...h.slice(-MAX_HISTORY + 1), snapshot]);
  }, []);

  const addLog = useCallback((msg) => {
    setLog(l => [`${ts()}  ${msg}`, ...l].slice(0, MAX_LOG));
  }, []);

  // ── Active assumptions (observed vs assumed) ──
  const obs = computeObserved(transitions);
  const activeA = useObserved ? {
    ...assumptions,
    scheduledToCCTA: obs.schedToCCTA ?? assumptions.scheduledToCCTA,
    cctaToProact2:   obs.cctaToP2   ?? assumptions.cctaToProact2,
  } : assumptions;

  // ── Projections ──
  const upProj       = computeUpstreamProjection(counts, activeA);
  const dnProj       = computeDownstreamProjection(counts, activeA);
  const scenarioUpProj = scenario ? computeUpstreamProjection(counts, activeA, scenario.counts) : null;

  // ── Derived metrics ──
  const resolvedPostCCTA = counts.proact1 + counts.proact2;
  const plaqueProportion = resolvedPostCCTA > 0 ? counts.proact2 / resolvedPostCCTA : null;
  const activeFollowup   = Math.max(0, counts.randomized - counts.completedCCTA - counts.attrited);
  const attritionRate    = counts.randomized > 0 ? counts.attrited / counts.randomized : null;
  const completionRate   = counts.randomized > 0 ? counts.completedCCTA / counts.randomized : null;
  const totalProact2Proj = counts.proact2 + upProj.projAdditional;
  const randGap          = Math.max(0, goals.randomized - (counts.randomized + dnProj.projNewRand));
  const neededScheduled  = randGap > 0 ? Math.ceil(randGap / (activeA.inviteToScheduled > 0 ? activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized : activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized)) : 0;
  const inPipeline       = counts.invited + counts.scheduled + counts.ccta;

  // ══════════════════════════════════════════════════════════════════
  // TRANSITION FUNCTIONS
  // Each function: snapshot → update counts+transitions → log
  // Naming: action_sourceStage or action_destStage
  // ══════════════════════════════════════════════════════════════════

  // Generic direct-edit (bulk set for a single field)
  const directEdit = useCallback((field, newValue, label) => {
    const s = snap();
    pushHistory(s);
    setCounts(c => ({ ...c, [field]: Math.max(0, newValue) }));
    addLog(`Direct edit: ${label} set to ${newValue}`);
  }, [snap, pushHistory, addLog]);

  // ── Invited ──
  const addInvited = useCallback(() => {
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, invited: c.invited + 1 }));
    addLog("+1 invited from biobank");
  }, [snap, pushHistory, addLog]);

  const removeInvited = useCallback(() => {
    if (counts.invited < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, invited: c.invited - 1 }));
    addLog("−1 invited (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // ── Scheduled ──
  // +: person moves invited→scheduled (free-add if invited=0)
  const addScheduled = useCallback(() => {
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, scheduled: c.scheduled + 1, invited: c.invited > 0 ? c.invited - 1 : c.invited }));
    setTransitions(t => ({ ...t, invitedToScheduled: t.invitedToScheduled + 1 }));
    const y = (activeA.scheduledToCCTA * activeA.cctaToProact2).toFixed(2);
    addLog(`+1 consent scheduled  (proj yield → PROACT 2: ${y})`);
  }, [snap, pushHistory, addLog, activeA]);

  // −: scheduled declined/lost
  const declineScheduled = useCallback(() => {
    if (counts.scheduled < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, scheduled: c.scheduled - 1, declined: c.declined + 1 }));
    setTransitions(t => ({ ...t, scheduledToDeclined: t.scheduledToDeclined + 1 }));
    addLog("−1 scheduled → Declined / Lost");
  }, [counts, snap, pushHistory, addLog]);

  // ── CCTA ──
  // Advance: scheduled → CCTA (must come from scheduled)
  const advanceToCCTA = useCallback(() => {
    if (counts.scheduled < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, scheduled: c.scheduled - 1, ccta: c.ccta + 1 }));
    setTransitions(t => ({ ...t, scheduledToCCTA: t.scheduledToCCTA + 1 }));
    addLog("Scheduled → Consented / CCTA");
  }, [counts, snap, pushHistory, addLog]);

  const removeCCTA = useCallback(() => {
    if (counts.ccta < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, ccta: c.ccta - 1 }));
    addLog("−1 Consented/CCTA (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // ── Post-CCTA branches ──
  // CCTA → PROACT 1 (no plaque, enrolled in disclosure arm)
  const advanceToProact1 = useCallback(() => {
    if (counts.ccta < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, ccta: c.ccta - 1, proact1: c.proact1 + 1 }));
    setTransitions(t => ({ ...t, cctaToProact1: t.cctaToProact1 + 1 }));
    addLog("CCTA → PROACT 1  (no plaque; randomized to disclosure arm)");
  }, [counts, snap, pushHistory, addLog]);

  const removeProact1 = useCallback(() => {
    if (counts.proact1 < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, proact1: c.proact1 - 1 }));
    addLog("−1 PROACT 1 (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // CCTA → PROACT 2 (plaque-positive)
  const advanceToProact2 = useCallback(() => {
    if (counts.ccta < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, ccta: c.ccta - 1, proact2: c.proact2 + 1 }));
    setTransitions(t => ({ ...t, cctaToProact2: t.cctaToProact2 + 1 }));
    addLog("CCTA → PROACT 2  ✓ plaque-positive enrolled");
  }, [counts, snap, pushHistory, addLog]);

  const removeProact2 = useCallback(() => {
    if (counts.proact2 < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, proact2: c.proact2 - 1 }));
    addLog("−1 PROACT 2 (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // CCTA → No plaque / other exclusion
  const advanceToNoPlaque = useCallback(() => {
    if (counts.ccta < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, ccta: c.ccta - 1, noPlaque: c.noPlaque + 1 }));
    setTransitions(t => ({ ...t, cctaToNoPlaque: t.cctaToNoPlaque + 1 }));
    addLog("CCTA → No Plaque / Excluded (no study path)");
  }, [counts, snap, pushHistory, addLog]);

  const removeNoPlaque = useCallback(() => {
    if (counts.noPlaque < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, noPlaque: c.noPlaque - 1 }));
    addLog("−1 No Plaque (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // ── PROACT 2 sub-pipeline ──
  // PROACT 2 → Randomized (subset; proact2 total does not decrement)
  const addRandomized = useCallback(() => {
    // Guard: randomized cannot exceed proact2
    if (counts.randomized >= counts.proact2) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, randomized: c.randomized + 1 }));
    setTransitions(t => ({ ...t, proact2ToRandomized: t.proact2ToRandomized + 1 }));
    addLog("+1 Randomized in PROACT 2");
  }, [counts, snap, pushHistory, addLog]);

  const removeRandomized = useCallback(() => {
    if (counts.randomized < 1) return;
    const s = snap(); pushHistory(s);
    // If removing randomized, also adjust subsets to stay ≤ randomized
    const newRand = counts.randomized - 1;
    setCounts(c => ({
      ...c,
      randomized:    newRand,
      completedCCTA: Math.min(c.completedCCTA, newRand),
      attrited:      Math.min(c.attrited, Math.max(0, newRand - c.completedCCTA)),
    }));
    addLog("−1 Randomized (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // Randomized → Final CCTA completed
  const addCompletedCCTA = useCallback(() => {
    // Guard: completedCCTA + attrited cannot exceed randomized
    if (counts.completedCCTA + counts.attrited >= counts.randomized) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, completedCCTA: c.completedCCTA + 1 }));
    setTransitions(t => ({ ...t, randomizedToCompleted: t.randomizedToCompleted + 1 }));
    addLog("+1 PROACT 2 final CCTA completed");
  }, [counts, snap, pushHistory, addLog]);

  const removeCompletedCCTA = useCallback(() => {
    if (counts.completedCCTA < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, completedCCTA: c.completedCCTA - 1 }));
    addLog("−1 Final CCTA completed (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // Randomized → Attrited / LTFU
  const addAttrited = useCallback(() => {
    if (counts.completedCCTA + counts.attrited >= counts.randomized) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, attrited: c.attrited + 1 }));
    setTransitions(t => ({ ...t, randomizedToAttrited: t.randomizedToAttrited + 1 }));
    addLog("+1 PROACT 2 attrition / LTFU");
  }, [counts, snap, pushHistory, addLog]);

  const removeAttrited = useCallback(() => {
    if (counts.attrited < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, attrited: c.attrited - 1 }));
    addLog("−1 Attrited (correction)");
  }, [counts, snap, pushHistory, addLog]);

  const removeDeclined = useCallback(() => {
    if (counts.declined < 1) return;
    const s = snap(); pushHistory(s);
    setCounts(c => ({ ...c, declined: c.declined - 1 }));
    addLog("−1 Declined (correction)");
  }, [counts, snap, pushHistory, addLog]);

  // ── Undo ──
  const undo = useCallback(() => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, -1));
    setCounts(prev.counts);
    setTransitions(prev.transitions);
    setLog(prev.log);
  }, [history]);

  // ── Reset ──
  const doReset = useCallback(() => {
    const s = snap(); pushHistory(s);
    setCounts({ ...DEFAULT_COUNTS });
    setTransitions({ ...DEFAULT_TRANSITIONS });
    setLog([]);
    setScenario(null);
    setConfirmReset(false);
    addLog("— Dashboard reset to zero —");
  }, [snap, pushHistory, addLog]);

  // ── Demo ──
  const loadDemo = useCallback(() => {
    const s = snap(); pushHistory(s);
    setCounts({ ...DEMO.counts });
    setTransitions({ ...DEMO.transitions });
    setScenario(null);
    addLog("— Demo data loaded —");
  }, [snap, pushHistory, addLog]);

  // ── Export / Import ──
  const exportState = () => {
    const blob = new Blob([JSON.stringify({ counts, transitions, assumptions, log, goals }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = `proact_state_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  };

  const importState = () => {
    try {
      const s = JSON.parse(importText);
      const sv = snap(); pushHistory(sv);
      if (s.counts)      setCounts(s.counts);
      if (s.transitions) setTransitions(s.transitions);
      if (s.assumptions) setAssumptions(s.assumptions);
      if (s.log)         setLog(s.log);
      if (s.goals)       { setGoals(s.goals); setGoalInput(String(s.goals.randomized ?? 220)); }
      setImportText(""); setImportError("");
      addLog("— State imported from JSON —");
    } catch (e) {
      setImportError("Invalid JSON: " + e.message);
    }
  };

  // ── Scenario ──
  const applyScenario = () => {
    const delta = parseInt(scenarioInput.delta) || 0;
    const field = scenarioInput.field;
    const shadow = { ...counts, [field]: Math.max(0, counts[field] + delta) };
    setScenario({ counts: shadow, field, delta });
  };
  const confirmScenario = () => {
    if (!scenario) return;
    const s = snap(); pushHistory(s);
    setCounts(scenario.counts);
    addLog(`Scenario confirmed: +${scenario.delta} to ${scenario.field}`);
    setScenario(null);
  };

  // ─── CSS helpers ──────────────────────────────────────────────────────────
  const card = { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "16px 18px", marginBottom: 14 };
  const p2Active = counts.randomized < counts.proact2;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: sans, padding: "20px 18px", maxWidth: 1100, margin: "0 auto" }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <div style={{ marginBottom: 18, borderBottom: `1px solid ${C.border}`, paddingBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ display: "flex", gap: 10, marginBottom: 3, alignItems: "center" }}>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.textMute, letterSpacing: "0.16em" }}>PROACT</span>
            <span style={{ color: C.border }}>·</span>
            <span style={{ fontFamily: mono, fontSize: 10, color: C.textMute, letterSpacing: "0.12em" }}>ENROLLMENT OPERATIONS DASHBOARD · v2</span>
            {savedAt && <span style={{ fontFamily: mono, fontSize: 10, color: "#22c55e", marginLeft: 8 }}>✓ autosaved {savedAt}</span>}
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, letterSpacing: "-0.02em", color: C.text }}>
            Funnel Tracker &amp; Projection Engine
          </h1>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={loadDemo} style={{ padding: "6px 11px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMid, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Demo</button>
          <button onClick={exportState} style={{ padding: "6px 11px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMid, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>↓ Export</button>
          <button onClick={undo} disabled={history.length === 0} style={{ padding: "6px 11px", background: "transparent", border: `1px solid ${history.length ? C.invited : C.border}`, borderRadius: 5, color: history.length ? C.invited : C.textMute, fontSize: 11, fontFamily: mono, cursor: history.length ? "pointer" : "not-allowed" }}>↩ Undo</button>
          {!confirmReset ? (
            <button onClick={() => setConfirmReset(true)} style={{ padding: "6px 11px", background: "transparent", border: `1px solid #fca5a5`, borderRadius: 5, color: C.attrited, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Reset</button>
          ) : (
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={doReset} style={{ padding: "6px 10px", background: "#fff1f1", border: `1px solid ${C.attrited}`, borderRadius: 5, color: C.attrited, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Confirm reset</button>
              <button onClick={() => setConfirmReset(false)} style={{ padding: "6px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMute, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* ── KPI row ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        <KpiCard label="PROACT 1 ENROLLED"    value={counts.proact1}   color={C.proact1} sub="No-plaque, disclosure arm" />
        <KpiCard label="PROACT 2 ENROLLED"    value={counts.proact2}   color={C.proact2} sub={`${resolvedPostCCTA > 0 ? ((counts.proact2/resolvedPostCCTA)*100).toFixed(0) : "—"}% of resolved post-CCTA`} />
        <KpiCard label="RANDOMIZED (P2)"      value={counts.randomized} color={C.random}  sub={`of ${goals.randomized} target · gap ${Math.max(0, goals.randomized - counts.randomized)}`} badge={counts.randomized >= goals.randomized ? "Target met" : undefined} />
        <KpiCard label="FINAL CCTA DONE"      value={counts.completedCCTA} color={C.completed} sub={completionRate !== null ? `${(completionRate*100).toFixed(0)}% of randomized` : "—"} />
        <KpiCard label="ATTRITION / LTFU"     value={counts.attrited}  color={C.attrited} sub={attritionRate !== null ? `${(attritionRate*100).toFixed(0)}% of randomized` : "—"} small />
      </div>

      {/* ── Projection strip ── */}
      <div style={{ ...card, background: "#eef4ff", border: "1px solid #c7d9f8", marginBottom: 18, padding: "12px 18px" }}>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, letterSpacing: "0.1em", minWidth: 120 }}>UPSTREAM PROJECTION</div>
          {[
            { label: "P2 actual",     val: counts.proact2,          color: C.proact2 },
            { label: "From CCTA",     val: upProj.fromCCTA,         color: C.ccta },
            { label: "From scheduled",val: upProj.fromScheduled,    color: C.scheduled },
            { label: "From invited",  val: upProj.fromInvited,      color: C.invited },
            { label: "Total proj. P2",val: totalProact2Proj,        color: C.kpiTotal, bold: true },
          ].map(({ label, val, color, bold }) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: color }} />
              <span style={{ fontSize: 11, color: C.textMid, fontFamily: mono }}>{label}</span>
              <span style={{ fontSize: 13, color, fontFamily: mono, fontWeight: bold ? 700 : 600 }}>{fmt1(val)}</span>
            </div>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 11, color: C.textMute, fontFamily: mono }}>
            <span onClick={() => setUseObserved(r => !r)} style={{ color: C.invited, cursor: "pointer", textDecoration: "underline" }}>
              {useObserved ? "using observed rates" : "using assumed rates"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 2, marginBottom: 0, borderBottom: `1px solid ${C.border}` }}>
        {[
          { id: "tracker",  label: "Funnel Tracker" },
          { id: "p2status", label: "PROACT 2 Status" },
          { id: "scenario", label: "Scenario" },
          { id: "goal",     label: "Goal Tracker" },
          { id: "rates",    label: "Assumptions" },
          { id: "data",     label: "Data & Export" },
          { id: "log",      label: "Event Log", badge: log.length },
        ].map(t => <Tab key={t.id} id={t.id} label={t.label} active={activeTab === t.id} onClick={setActiveTab} badge={t.badge} />)}
      </div>
      <div style={{ height: 14 }} />

      {/* ════ TAB: Funnel Tracker ════ */}
      {activeTab === "tracker" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 14 }}>
          <div>
            {/* Upstream funnel */}
            <div style={card}>
              <SectionLabel color={C.invited}>Upstream Accrual Pipeline</SectionLabel>
              <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 12 }}>
                Click count to type a value directly. Use +/− for incremental updates. Advance buttons move individuals downstream.
              </div>

              <FunnelRow label="Invited" sublabel="Identified from MGB Biobank" color={C.invited}
                count={counts.invited}
                onDirectEdit={v => directEdit("invited", v, "Invited")}
                onPlus={addInvited} onMinus={removeInvited} minusDisabled={counts.invited < 1}
                yieldPer={activeA.inviteToScheduled * activeA.scheduledToCCTA * activeA.cctaToProact2}
                projContrib={upProj.fromInvited}
              />
              <div style={{ textAlign: "center", fontSize: 11, color: C.textMute, fontFamily: mono, margin: "2px 0" }}>
                ↓ {(activeA.inviteToScheduled * 100).toFixed(0)}% schedule
              </div>
              <FunnelRow label="Consent Scheduled" sublabel="Upcoming consent call" color={C.scheduled}
                count={counts.scheduled}
                onDirectEdit={v => directEdit("scheduled", v, "Consent Scheduled")}
                onPlus={addScheduled} onMinus={declineScheduled}
                minusDisabled={counts.scheduled < 1}
                advance={advanceToCCTA} advanceLabel="→ Consented" advanceDisabled={counts.scheduled < 1}
                yieldPer={activeA.scheduledToCCTA * activeA.cctaToProact2}
                projContrib={upProj.fromScheduled}
              />
              <div style={{ textAlign: "center", fontSize: 11, color: C.textMute, fontFamily: mono, margin: "2px 0" }}>
                ↓ {(activeA.scheduledToCCTA * 100).toFixed(0)}% consent
              </div>
              <FunnelRow label="Consented / CCTA" sublabel="Consented; awaiting or completing CT" color={C.ccta}
                count={counts.ccta}
                onDirectEdit={v => directEdit("ccta", v, "Consented/CCTA")}
                onPlus={advanceToCCTA} onMinus={removeCCTA}
                plusDisabled={counts.scheduled < 1} minusDisabled={counts.ccta < 1}
                yieldPer={activeA.cctaToProact2}
                projContrib={upProj.fromCCTA}
              />
            </div>

            {/* Post-CCTA branch */}
            <div style={card}>
              <SectionLabel color={C.ccta}>Post-CCTA Study Path Outcomes</SectionLabel>
              <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 12 }}>
                CCTA results determine study path. PROACT 1 (no plaque) and PROACT 2 (plaque) are parallel study outcomes, not attrition.
              </div>

              {/* CCTA branch buttons */}
              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button onClick={advanceToProact1} disabled={counts.ccta < 1} style={{
                  flex: 1, padding: "8px", borderRadius: 5, fontFamily: mono, fontSize: 11,
                  background: counts.ccta > 0 ? "#f5f0ff" : "transparent",
                  border: `1px solid ${counts.ccta > 0 ? C.proact1 : C.border}`,
                  color: counts.ccta > 0 ? C.proact1 : C.textMute,
                  cursor: counts.ccta > 0 ? "pointer" : "not-allowed",
                }}>CCTA → PROACT 1  (no plaque)</button>
                <button onClick={advanceToProact2} disabled={counts.ccta < 1} style={{
                  flex: 1, padding: "8px", borderRadius: 5, fontFamily: mono, fontSize: 11,
                  background: counts.ccta > 0 ? "#f0faf3" : "transparent",
                  border: `1px solid ${counts.ccta > 0 ? C.proact2 : C.border}`,
                  color: counts.ccta > 0 ? C.proact2 : C.textMute,
                  cursor: counts.ccta > 0 ? "pointer" : "not-allowed",
                }}>✓ CCTA → PROACT 2  (plaque)</button>
                <button onClick={advanceToNoPlaque} disabled={counts.ccta < 1} style={{
                  flex: 1, padding: "8px", borderRadius: 5, fontFamily: mono, fontSize: 11,
                  background: "transparent", border: `1px solid ${counts.ccta > 0 ? C.borderAcc : C.border}`,
                  color: counts.ccta > 0 ? C.textMid : C.textMute,
                  cursor: counts.ccta > 0 ? "pointer" : "not-allowed",
                }}>→ No Plaque / Excluded</button>
              </div>

              {/* Study path cards */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { label: "PROACT 1", sub: "No-plaque disclosure arm", count: counts.proact1, color: C.proact1, onMinus: removeProact1, minusD: counts.proact1 < 1, onEdit: v => directEdit("proact1", v, "PROACT 1"), isFinal: true },
                  { label: "PROACT 2", sub: "Plaque-positive enrolled", count: counts.proact2, color: C.proact2, onMinus: removeProact2, minusD: counts.proact2 < 1, onEdit: v => directEdit("proact2", v, "PROACT 2"), isFinal: true },
                  { label: "No Plaque / Excl.", sub: "Not eligible for either arm", count: counts.noPlaque, color: C.noPlaque, onMinus: removeNoPlaque, minusD: counts.noPlaque < 1, onEdit: v => directEdit("noPlaque", v, "No Plaque"), isDead: true },
                ].map(({ label, sub, count, color, onMinus, minusD, onEdit, isFinal, isDead }) => (
                  <div key={label} style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`, borderRadius: 7, padding: "12px 14px" }}>
                    <div style={{ fontSize: 12, color: C.textMid, fontFamily: mono, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 8 }}>{sub}</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <InlineEdit value={count} onSave={onEdit} />
                      <div style={{ display: "flex", gap: 4 }}>
                        <StepBtn onClick={onMinus} disabled={minusD} red>−</StepBtn>
                        <Pill color={isFinal ? color : C.textMute}>{isFinal ? "enrolled" : "exit"}</Pill>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Plaque proportion */}
              {resolvedPostCCTA > 0 && (
                <div style={{ marginTop: 12, padding: "10px 14px", background: "#f8f9fc", borderRadius: 6, border: `1px solid ${C.border}`, display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, letterSpacing: "0.1em" }}>OBSERVED PLAQUE PROPORTION</div>
                    <div style={{ fontSize: 20, color: C.proact2, fontFamily: mono, fontWeight: 700 }}>{fmtPct(counts.proact2, resolvedPostCCTA)}</div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>PROACT 2 / (PROACT 1 + PROACT 2), n={resolvedPostCCTA}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, letterSpacing: "0.1em" }}>PROACT 1 / PROACT 2 SPLIT</div>
                    <div style={{ fontSize: 16, color: C.text, fontFamily: mono, fontWeight: 600 }}>{counts.proact1} : {counts.proact2}</div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>Assumed rate: {(activeA.cctaToProact2 * 100).toFixed(0)}%</div>
                  </div>
                </div>
              )}
            </div>

            {/* Exit buckets */}
            <div style={card}>
              <SectionLabel>Attrition Before CCTA</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { label: "Declined / Lost (post-scheduling)", count: counts.declined, color: C.declined, onMinus: removeDeclined, minusD: counts.declined < 1, onEdit: v => directEdit("declined", v, "Declined") },
                ].map(({ label, count, color, onMinus, minusD, onEdit }) => (
                  <div key={label} style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`, borderRadius: 7, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>{label}</div>
                      <InlineEdit value={count} onSave={onEdit} />
                    </div>
                    <StepBtn onClick={onMinus} disabled={minusD} red>−</StepBtn>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Sidebar: funnel summary */}
          <div>
            <div style={card}>
              <SectionLabel>Pipeline Summary</SectionLabel>
              {[
                { label: "Invited",        count: counts.invited,    color: C.invited },
                { label: "Scheduled",      count: counts.scheduled,  color: C.scheduled },
                { label: "Consented/CCTA", count: counts.ccta,       color: C.ccta },
                { label: "PROACT 1",       count: counts.proact1,    color: C.proact1 },
                { label: "PROACT 2",       count: counts.proact2,    color: C.proact2 },
                { label: "Randomized",     count: counts.randomized, color: C.random },
                { label: "Final CCTA",     count: counts.completedCCTA, color: C.completed },
                { label: "Attrited",       count: counts.attrited,   color: C.attrited },
                { label: "No Plaque",      count: counts.noPlaque,   color: C.noPlaque },
                { label: "Declined",       count: counts.declined,   color: C.declined },
              ].map(({ label, count, color }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 7, alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
                    <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>{label}</span>
                  </div>
                  <span style={{ fontSize: 14, fontFamily: mono, color, fontWeight: 700 }}>{count}</span>
                </div>
              ))}
              <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: C.textMute, fontFamily: mono }}>Total tracked</span>
                <span style={{ fontSize: 12, color: C.text, fontFamily: mono }}>{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
              </div>
            </div>

            <div style={card}>
              <SectionLabel>Observed Conversion</SectionLabel>
              {[
                { label: "Sched → CCTA", n: transitions.scheduledToCCTA, d: transitions.scheduledToCCTA + transitions.scheduledToDeclined, assumed: activeA.scheduledToCCTA },
                { label: "CCTA → P2",   n: transitions.cctaToProact2,    d: transitions.cctaToProact1 + transitions.cctaToProact2 + transitions.cctaToNoPlaque, assumed: activeA.cctaToProact2 },
                { label: "P2 → Rand.",  n: transitions.proact2ToRandomized, d: counts.proact2, assumed: activeA.proact2ToRandomized },
              ].map(({ label, n, d, assumed }) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 11, color: C.textMid, fontFamily: mono }}>{label}</span>
                    <span style={{ fontSize: 12, color: d > 0 ? C.text : C.textMute, fontFamily: mono }}>
                      {d > 0 ? `${((n / d) * 100).toFixed(0)}%` : "—"}
                      {d > 0 && <span style={{ fontSize: 10, color: C.textMute }}> ({n}/{d})</span>}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>assumed: {(assumed * 100).toFixed(0)}%</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ════ TAB: PROACT 2 Status ════ */}
      {activeTab === "p2status" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 14 }}>
          <div>
            {/* P2 sub-pipeline */}
            <div style={card}>
              <SectionLabel color={C.proact2}>PROACT 2 Follow-up Status</SectionLabel>
              <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 14, lineHeight: 1.6 }}>
                Randomized, Final CCTA, and Attrition are all subsets of total PROACT 2 enrolled.
                <br/>Guards enforce: Randomized ≤ PROACT 2 total; Completed + Attrited ≤ Randomized.
              </div>

              <FunnelRow label="PROACT 2 Enrolled (total)" sublabel="Plaque-positive; cumulative" color={C.proact2}
                count={counts.proact2}
                onDirectEdit={v => directEdit("proact2", v, "PROACT 2 Total")}
                onPlus={advanceToProact2} onMinus={removeProact2}
                plusDisabled={counts.ccta < 1} minusDisabled={counts.proact2 < 1}
                isFinal noProj
              />
              <div style={{ textAlign: "center", fontSize: 11, color: C.textMute, fontFamily: mono, margin: "2px 0" }}>
                ↓ subset
              </div>
              <FunnelRow label="Randomized in PROACT 2" sublabel={`Subset of P2 total · max = ${counts.proact2}`} color={C.random}
                count={counts.randomized}
                onDirectEdit={v => directEdit("randomized", Math.min(v, counts.proact2), "Randomized")}
                onPlus={addRandomized} onMinus={removeRandomized}
                plusDisabled={counts.randomized >= counts.proact2}
                minusDisabled={counts.randomized < 1}
                isFinal noProj isSubset
              />
              <div style={{ textAlign: "center", fontSize: 11, color: C.textMute, fontFamily: mono, margin: "2px 0" }}>
                ↓ follow-up outcomes
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 4 }}>
                {[
                  { label: "Active Follow-up", sub: "rand − completed − attrited", count: activeFollowup, color: C.ccta, readOnly: true },
                  { label: "Final CCTA Completed", sub: `${completionRate !== null ? fmtPct(counts.completedCCTA, counts.randomized) : "—"} of randomized`, count: counts.completedCCTA, color: C.completed, onPlus: addCompletedCCTA, onMinus: removeCompletedCCTA, plusD: counts.completedCCTA + counts.attrited >= counts.randomized, minusD: counts.completedCCTA < 1, onEdit: v => directEdit("completedCCTA", Math.min(v, Math.max(0, counts.randomized - counts.attrited)), "Final CCTA Completed") },
                  { label: "Attrition / LTFU", sub: `${attritionRate !== null ? fmtPct(counts.attrited, counts.randomized) : "—"} of randomized`, count: counts.attrited, color: C.attrited, onPlus: addAttrited, onMinus: removeAttrited, plusD: counts.completedCCTA + counts.attrited >= counts.randomized, minusD: counts.attrited < 1, onEdit: v => directEdit("attrited", Math.min(v, Math.max(0, counts.randomized - counts.completedCCTA)), "Attrited/LTFU") },
                ].map(({ label, sub, count, color, onPlus, onMinus, plusD, minusD, onEdit, readOnly }) => (
                  <div key={label} style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderTop: `3px solid ${color}`, borderRadius: 7, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: C.textMid, fontFamily: mono, marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, marginBottom: 8 }}>{sub}</div>
                    {readOnly ? (
                      <div style={{ fontSize: 22, color, fontFamily: mono, fontWeight: 700 }}>{count}</div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <InlineEdit value={count} onSave={onEdit} />
                        <div style={{ display: "flex", gap: 3 }}>
                          <StepBtn onClick={onMinus} disabled={minusD} red>−</StepBtn>
                          <StepBtn onClick={onPlus} disabled={plusD}>+</StepBtn>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Follow-up status bar */}
            {counts.randomized > 0 && (
              <div style={card}>
                <SectionLabel>PROACT 2 Follow-up Breakdown</SectionLabel>
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", height: 20, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                    {[
                      { val: counts.completedCCTA, color: C.completed },
                      { val: activeFollowup, color: C.ccta },
                      { val: counts.attrited, color: C.attrited },
                    ].map(({ val, color }, i) => (
                      val > 0 ? (
                        <div key={i} style={{ flex: val, background: color, opacity: 0.85, transition: "flex 0.4s ease" }} title={val} />
                      ) : null
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    {[
                      { label: "Completed final CCTA", val: counts.completedCCTA, color: C.completed },
                      { label: "Active follow-up", val: activeFollowup, color: C.ccta },
                      { label: "Attrition / LTFU", val: counts.attrited, color: C.attrited },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontFamily: mono, color: C.textMid }}>
                        <div style={{ width: 8, height: 8, background: color, borderRadius: 2 }} />
                        {label}: <span style={{ color, fontWeight: 700 }}>{val}</span> ({fmtPct(val, counts.randomized)})
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Downstream projections */}
            <div style={{ ...card, background: "#f3faf5", border: `1px solid #b7e4c7` }}>
              <SectionLabel color={C.proact2}>Downstream Projections (PROACT 2)</SectionLabel>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { label: "Pending randomization", val: dnProj.pendingRand, sub: "proact2 − randomized", color: C.proact2 },
                  { label: "Proj. new randomized", val: dnProj.projNewRand.toFixed(1), sub: `×${(activeA.proact2ToRandomized*100).toFixed(0)}%`, color: C.random },
                  { label: "Total proj. randomized", val: dnProj.totalRandProj.toFixed(1), sub: `vs target ${goals.randomized}`, color: dnProj.totalRandProj >= goals.randomized ? C.proact2 : C.kpiWarn },
                  { label: "Proj. completed CCTA",  val: dnProj.projCompleted.toFixed(1), sub: `×${(activeA.randomizedToCompleted*100).toFixed(0)}%`, color: C.completed },
                  { label: "Proj. attrited",        val: dnProj.projAttrited.toFixed(1),  sub: `×${(activeA.randomizedAttrition*100).toFixed(0)}%`, color: C.attrited },
                  { label: "Randomization gap",     val: Math.max(0, goals.randomized - dnProj.totalRandProj).toFixed(1), sub: "additional needed", color: dnProj.totalRandProj >= goals.randomized ? C.proact2 : C.kpiWarn },
                ].map(({ label, val, sub, color }) => (
                  <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, marginBottom: 3 }}>{label}</div>
                    <div style={{ fontSize: 20, color, fontFamily: mono, fontWeight: 700 }}>{val}</div>
                    <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>{sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div>
            <div style={card}>
              <SectionLabel>Randomization Progress</SectionLabel>
              <div style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>Randomized</span>
                  <span style={{ fontSize: 12, color: C.random, fontFamily: mono, fontWeight: 700 }}>{counts.randomized} / {goals.randomized}</span>
                </div>
                <div style={{ background: C.bg, borderRadius: 4, height: 10, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, (counts.randomized / goals.randomized) * 100)}%`, background: C.random, borderRadius: 4, transition: "width 0.4s" }} />
                </div>
                <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginTop: 4 }}>
                  {fmtPct(counts.randomized, goals.randomized)} of target
                </div>
              </div>
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 4 }}>
                <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, letterSpacing: "0.1em", marginBottom: 8 }}>CHANGE TARGET</div>
                <input type="number" min={1} value={goalInput}
                  onChange={e => { setGoalInput(e.target.value); const n = parseInt(e.target.value); if (!isNaN(n) && n > 0) setGoals(g => ({ ...g, randomized: n })); }}
                  style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: "7px 10px", borderRadius: 5, fontSize: 16, fontFamily: mono, textAlign: "center" }}
                />
              </div>
            </div>

            <div style={card}>
              <SectionLabel>Key Ratios</SectionLabel>
              {[
                { label: "Plaque proportion", val: plaqueProportion !== null ? fmtPct(counts.proact2, resolvedPostCCTA) : "—", sub: `P2 / (P1+P2), n=${resolvedPostCCTA}`, color: C.proact2 },
                { label: "Randomization rate", val: counts.proact2 > 0 ? fmtPct(counts.randomized, counts.proact2) : "—", sub: "Rand / P2 total", color: C.random },
                { label: "Completion rate", val: completionRate !== null ? fmtPct(counts.completedCCTA, counts.randomized) : "—", sub: "Final CCTA / Randomized", color: C.completed },
                { label: "Attrition rate", val: attritionRate !== null ? fmtPct(counts.attrited, counts.randomized) : "—", sub: "LTFU / Randomized", color: C.attrited },
                { label: "Active follow-up", val: counts.randomized > 0 ? fmtPct(activeFollowup, counts.randomized) : "—", sub: "Active / Randomized", color: C.ccta },
              ].map(({ label, val, sub, color }) => (
                <div key={label} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                    <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>{label}</span>
                    <span style={{ fontSize: 14, color, fontFamily: mono, fontWeight: 700 }}>{val}</span>
                  </div>
                  <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono }}>{sub}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ════ TAB: Scenario ════ */}
      {activeTab === "scenario" && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
          <div style={card}>
            <SectionLabel>What-If Scenario</SectionLabel>
            <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 14, lineHeight: 1.6 }}>
              Preview impact of adding people at any upstream stage. Counts are not committed until confirmed.
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: C.textMid, fontFamily: mono, marginBottom: 4 }}>Add to stage</div>
              <select value={scenarioInput.field} onChange={e => setScenarioInput(s => ({ ...s, field: e.target.value }))} style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: "6px 9px", borderRadius: 5, fontSize: 12, fontFamily: mono }}>
                <option value="invited">Invited</option>
                <option value="scheduled">Consent Scheduled</option>
                <option value="ccta">Consented / CCTA</option>
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: C.textMid, fontFamily: mono, marginBottom: 4 }}>Number to add</div>
              <input type="number" min={1} max={5000} value={scenarioInput.delta}
                onChange={e => setScenarioInput(s => ({ ...s, delta: e.target.value }))}
                style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: "6px 9px", borderRadius: 5, fontSize: 12, fontFamily: mono }}
              />
            </div>
            <button onClick={applyScenario} style={{ width: "100%", padding: "9px", background: "#e8f0fe", border: `1px solid ${C.invited}`, borderRadius: 5, color: C.invited, fontSize: 12, fontFamily: mono, cursor: "pointer", marginBottom: 8 }}>Preview</button>
            {scenario && (
              <>
                <button onClick={confirmScenario} style={{ width: "100%", padding: "9px", background: "#f0faf3", border: `1px solid ${C.proact2}`, borderRadius: 5, color: C.proact2, fontSize: 12, fontFamily: mono, cursor: "pointer", marginBottom: 6 }}>Confirm → Apply to Real Counts</button>
                <button onClick={() => setScenario(null)} style={{ width: "100%", padding: "9px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMid, fontSize: 12, fontFamily: mono, cursor: "pointer" }}>Cancel</button>
              </>
            )}
          </div>
          <div>
            {scenario && scenarioUpProj ? (
              <div style={card}>
                <SectionLabel>Scenario Preview</SectionLabel>
                <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
                  <KpiCard label="SCENARIO PROJ. P2 (TOTAL)" value={(counts.proact2 + scenarioUpProj.projAdditional).toFixed(1)} color={C.kpiProj} sub="Actual + upstream projected" />
                  <KpiCard label="DELTA vs CURRENT" value={(scenarioUpProj.projAdditional - upProj.projAdditional).toFixed(1)} color={C.proact2} sub="Additional P2 from scenario" />
                </div>
                <div style={{ fontFamily: mono, fontSize: 12, color: C.textMid, lineHeight: 1.9 }}>
                  <div>Adding <strong>{scenarioInput.delta}</strong> to <strong>{scenarioInput.field}</strong></div>
                  <div>Current total P2 projection: <strong>{totalProact2Proj.toFixed(1)}</strong></div>
                  <div>Scenario total P2 projection: <strong>{(counts.proact2 + scenarioUpProj.projAdditional).toFixed(1)}</strong></div>
                  {scenarioInput.field === "scheduled" && <div>Yield per scheduled consent: <strong>{(activeA.scheduledToCCTA * activeA.cctaToProact2).toFixed(3)}</strong></div>}
                  {scenarioInput.field === "invited" && <div>Yield per invite: <strong>{(activeA.inviteToScheduled * activeA.scheduledToCCTA * activeA.cctaToProact2).toFixed(4)}</strong></div>}
                </div>
              </div>
            ) : (
              <div style={{ ...card, minHeight: 200, display: "flex", alignItems: "center", justifyContent: "center", border: `1px dashed ${C.border}` }}>
                <span style={{ fontSize: 12, color: C.textMute, fontFamily: mono }}>Configure and preview a scenario</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ════ TAB: Goal Tracker ════ */}
      {activeTab === "goal" && (
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 14 }}>
          <div style={card}>
            <SectionLabel>Randomization Target</SectionLabel>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: C.textMid, fontFamily: mono, marginBottom: 4 }}>Target randomized participants</div>
              <input type="number" min={1} max={500} value={goalInput}
                onChange={e => { setGoalInput(e.target.value); const n = parseInt(e.target.value); if (!isNaN(n) && n > 0) setGoals(g => ({ ...g, randomized: n })); }}
                style={{ width: "100%", background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: "8px 10px", borderRadius: 5, fontSize: 18, fontFamily: mono, textAlign: "center" }}
              />
            </div>
            {[
              { label: "Target", val: goals.randomized, color: C.text },
              { label: "Randomized (actual)", val: counts.randomized, color: C.random },
              { label: "Proj. total randomized", val: dnProj.totalRandProj.toFixed(1), color: C.kpiProj },
              { label: "Remaining gap", val: Math.max(0, goals.randomized - dnProj.totalRandProj).toFixed(1), color: dnProj.totalRandProj >= goals.randomized ? C.proact2 : C.kpiWarn },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>{label}</span>
                <span style={{ fontSize: 13, color, fontFamily: mono, fontWeight: 700 }}>{val}</span>
              </div>
            ))}
          </div>
          <div style={card}>
            <SectionLabel>What's Needed to Close Randomization Gap</SectionLabel>
            {dnProj.totalRandProj >= goals.randomized ? (
              <div style={{ fontSize: 14, color: C.proact2, fontFamily: mono, padding: "20px 0" }}>✓ Randomization target met or exceeded under current projections.</div>
            ) : (
              <>
                <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 16, lineHeight: 1.6 }}>
                  Gap: <strong style={{ color: C.kpiWarn }}>{Math.max(0, goals.randomized - dnProj.totalRandProj).toFixed(1)}</strong> additional randomized PROACT 2 participants needed.
                </div>
                {[
                  {
                    label: "Additional Consent Scheduled",
                    val: Math.ceil(Math.max(0, goals.randomized - dnProj.totalRandProj) / (activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized)),
                    sub: `×${(activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized).toFixed(3)} yield/consent → randomized`,
                    color: C.scheduled,
                  },
                  {
                    label: "Additional Invites",
                    val: Math.ceil(Math.max(0, goals.randomized - dnProj.totalRandProj) / (activeA.inviteToScheduled * activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized)),
                    sub: `×${(activeA.inviteToScheduled * activeA.scheduledToCCTA * activeA.cctaToProact2 * activeA.proact2ToRandomized).toFixed(5)} yield/invite → randomized`,
                    color: C.invited,
                  },
                ].map(({ label, val, sub, color }) => (
                  <div key={label} style={{ ...card, border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 4 }}>{label}</div>
                    <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: mono, marginBottom: 4 }}>{val}</div>
                    <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono }}>{sub}</div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* ════ TAB: Assumptions ════ */}
      {activeTab === "rates" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={card}>
            <SectionLabel color={C.invited}>Upstream Accrual Assumptions</SectionLabel>
            <RateInput label="Invite → Consent Scheduled" value={assumptions.inviteToScheduled} onChange={v => setAssumptions(a => ({ ...a, inviteToScheduled: v }))} />
            <RateInput label="Scheduled → Consented/CCTA" value={assumptions.scheduledToCCTA}   onChange={v => setAssumptions(a => ({ ...a, scheduledToCCTA: v }))} />
            <RateInput label="CCTA → PROACT 2 (plaque)"  value={assumptions.cctaToProact2}      onChange={v => setAssumptions(a => ({ ...a, cctaToProact2: v }))} />
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 4 }}>
              <div style={{ fontSize: 10, color: C.textMute, fontFamily: mono, marginBottom: 8, letterSpacing: "0.1em" }}>DERIVED UPSTREAM YIELDS</div>
              {[
                { label: "Invite → PROACT 2",    val: assumptions.inviteToScheduled * assumptions.scheduledToCCTA * assumptions.cctaToProact2 },
                { label: "Scheduled → PROACT 2", val: assumptions.scheduledToCCTA * assumptions.cctaToProact2 },
                { label: "CCTA → PROACT 2",       val: assumptions.cctaToProact2 },
              ].map(({ label, val }) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 12, color: C.textMid, fontFamily: mono }}>{label}</span>
                  <span style={{ fontSize: 12, color: C.invited, fontFamily: mono }}>{val.toFixed(4)}</span>
                </div>
              ))}
            </div>
            <button onClick={() => setAssumptions(a => ({ ...a, inviteToScheduled: DEFAULT_ASSUMPTIONS.inviteToScheduled, scheduledToCCTA: DEFAULT_ASSUMPTIONS.scheduledToCCTA, cctaToProact2: DEFAULT_ASSUMPTIONS.cctaToProact2 }))} style={{ marginTop: 8, padding: "5px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMute, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Reset to defaults</button>
          </div>
          <div style={card}>
            <SectionLabel color={C.proact2}>Downstream Assumptions (PROACT 2)</SectionLabel>
            <RateInput label="PROACT 2 → Randomized"           value={assumptions.proact2ToRandomized}    onChange={v => setAssumptions(a => ({ ...a, proact2ToRandomized: v }))} />
            <RateInput label="Randomized → Final CCTA complete" value={assumptions.randomizedToCompleted} onChange={v => setAssumptions(a => ({ ...a, randomizedToCompleted: v }))} />
            <RateInput label="Randomized → Attrition / LTFU"   value={assumptions.randomizedAttrition}    onChange={v => setAssumptions(a => ({ ...a, randomizedAttrition: v }))} />
            <div style={{ marginTop: 10, padding: "10px 12px", background: "#f8f9fc", borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 11, color: C.textMute, fontFamily: mono, lineHeight: 1.6 }}>
              Downstream assumptions drive the PROACT 2 Status projections only. They do not affect the upstream accrual projections shown in the main strip.
            </div>
            <button onClick={() => setAssumptions(a => ({ ...a, proact2ToRandomized: DEFAULT_ASSUMPTIONS.proact2ToRandomized, randomizedToCompleted: DEFAULT_ASSUMPTIONS.randomizedToCompleted, randomizedAttrition: DEFAULT_ASSUMPTIONS.randomizedAttrition }))} style={{ marginTop: 8, padding: "5px 10px", background: "transparent", border: `1px solid ${C.border}`, borderRadius: 5, color: C.textMute, fontSize: 11, fontFamily: mono, cursor: "pointer" }}>Reset to defaults</button>
          </div>

          {/* Observed vs assumed */}
          <div style={{ ...card, gridColumn: "span 2" }}>
            <SectionLabel>Observed vs Assumed Conversion Rates</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
              {[
                { label: "Sched → CCTA", assumed: assumptions.scheduledToCCTA, obs: obs.schedToCCTA, n: transitions.scheduledToCCTA, d: transitions.scheduledToCCTA + transitions.scheduledToDeclined },
                { label: "CCTA → P2", assumed: assumptions.cctaToProact2, obs: obs.cctaToP2, n: transitions.cctaToProact2, d: transitions.cctaToProact1 + transitions.cctaToProact2 + transitions.cctaToNoPlaque },
                { label: "P2 → Rand.", assumed: assumptions.proact2ToRandomized, obs: counts.proact2 > 0 ? counts.randomized / counts.proact2 : null, n: counts.randomized, d: counts.proact2 },
                { label: "Rand → Complete", assumed: assumptions.randomizedToCompleted, obs: counts.randomized > 0 ? counts.completedCCTA / counts.randomized : null, n: counts.completedCCTA, d: counts.randomized },
              ].map(({ label, assumed, obs: o, n, d }) => (
                <div key={label} style={{ background: "#f8f9fc", border: `1px solid ${C.border}`, borderRadius: 6, padding: "10px 12px" }}>
                  <div style={{ fontSize: 11, color: C.textMid, fontFamily: mono, marginBottom: 8 }}>{label}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 9, color: C.textMute, fontFamily: mono }}>ASSUMED</div>
                      <div style={{ fontSize: 18, color: C.invited, fontFamily: mono, fontWeight: 700 }}>{(assumed * 100).toFixed(0)}%</div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 9, color: C.textMute, fontFamily: mono }}>OBSERVED</div>
                      <div style={{ fontSize: 18, color: o !== null ? C.proact2 : C.textMute, fontFamily: mono, fontWeight: 700 }}>{o !== null ? `${(o * 100).toFixed(0)}%` : "—"}</div>
                      {d > 0 && <div style={{ fontSize: 9, color: C.textMute, fontFamily: mono }}>{n}/{d}</div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, fontSize: 11, color: C.textMute, fontFamily: mono }}>
              Toggle between assumed and observed rates:{" "}
              <span onClick={() => setUseObserved(r => !r)} style={{ color: C.invited, cursor: "pointer", textDecoration: "underline" }}>
                currently using {useObserved ? "observed" : "assumed"} rates
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ════ TAB: Data & Export ════ */}
      {activeTab === "data" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <div style={card}>
            <SectionLabel>Export State</SectionLabel>
            <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 14, lineHeight: 1.6 }}>
              Download current state as JSON for backup, transfer, or sharing with collaborators.
            </div>
            <button onClick={exportState} style={{ width: "100%", padding: "10px", background: "#e8f0fe", border: `1px solid ${C.invited}`, borderRadius: 5, color: C.invited, fontSize: 13, fontFamily: mono, cursor: "pointer" }}>
              ↓ Download State JSON
            </button>
          </div>
          <div style={card}>
            <SectionLabel>Import State</SectionLabel>
            <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 10, lineHeight: 1.6 }}>
              Paste exported JSON to restore a saved state. Current state will be pushed to undo history.
            </div>
            <textarea value={importText} onChange={e => { setImportText(e.target.value); setImportError(""); }}
              placeholder="Paste JSON here…"
              style={{ width: "100%", height: 100, background: C.bg, border: `1px solid ${importError ? C.attrited : C.border}`, borderRadius: 5, color: C.text, padding: "8px 10px", fontSize: 11, fontFamily: mono, resize: "vertical", boxSizing: "border-box" }}
            />
            {importError && <div style={{ fontSize: 11, color: C.attrited, fontFamily: mono, marginBottom: 6 }}>{importError}</div>}
            <button onClick={importState} disabled={!importText.trim()} style={{ width: "100%", padding: "9px", background: importText.trim() ? "#f0faf3" : "transparent", border: `1px solid ${importText.trim() ? C.proact2 : C.border}`, borderRadius: 5, color: importText.trim() ? C.proact2 : C.textMute, fontSize: 12, fontFamily: mono, cursor: importText.trim() ? "pointer" : "not-allowed" }}>
              Import
            </button>
          </div>
          <div style={card}>
            <SectionLabel>Local Storage</SectionLabel>
            <div style={{ fontSize: 11, color: C.textMute, fontFamily: mono, marginBottom: 14, lineHeight: 1.6 }}>
              Data is autosaved to this browser's local storage. Clearing will erase all counts permanently (cannot be undone).
            </div>
            {savedAt && <div style={{ fontSize: 11, color: "#22c55e", fontFamily: mono, marginBottom: 10 }}>✓ Last autosaved at {savedAt}</div>}
            <button onClick={() => { if (window.confirm("Clear all locally saved data? This cannot be undone.")) { localStorage.removeItem(STORAGE_KEY); window.location.reload(); } }} style={{ padding: "7px 14px", background: "#fff1f1", border: `1px solid ${C.attrited}`, borderRadius: 5, color: C.attrited, fontSize: 12, fontFamily: mono, cursor: "pointer" }}>
              Clear saved data
            </button>
          </div>
        </div>
      )}

      {/* ════ TAB: Event Log ════ */}
      {activeTab === "log" && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <SectionLabel>Event Log</SectionLabel>
            <span style={{ fontSize: 11, color: C.textMute, fontFamily: mono }}>{log.length} events · last {MAX_LOG} shown</span>
          </div>
          {log.length === 0 ? (
            <div style={{ fontSize: 12, color: C.textMute, fontFamily: mono, padding: "20px 0" }}>No events yet.</div>
          ) : (
            <div style={{ maxHeight: 520, overflowY: "auto" }}>
              {log.map((entry, i) => (
                <div key={i} style={{
                  padding: "7px 10px", borderRadius: 4, marginBottom: 3,
                  background: i === 0 ? "#eef4ff" : "transparent",
                  border: i === 0 ? `1px solid #c7d9f8` : `1px solid transparent`,
                  fontFamily: mono, fontSize: 12,
                  color: i === 0 ? C.invited : C.textMid,
                }}>{entry}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
