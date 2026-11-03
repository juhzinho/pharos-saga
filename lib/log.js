// The saga's state log. Every transition is an append-only event; the current state is a pure fold of the
// events. The same fold rebuilds the state after a crash, so `resume` knows exactly which step it was in and
// which transaction hashes it had already broadcast.

export const STEP_STATUS = ["pending", "running", "waiting-gas", "submitted", "confirmed", "verified", "skipped", "failed", "compensated"];

function emptyStep(id, title, phase) {
  return { id, title, phase, status: "pending", attempts: 0, txs: [], receipt: null, checks: [], facts: {}, error: null, skipReason: null };
}

export function initialState() {
  return { id: null, status: "new", network: null, account: null, params: null, startedAt: null, updatedAt: null, order: [], compensation: [], steps: {}, current: null, facts: {}, start: null, end: null, failure: null, injected: [], seq: 0 };
}

/** Pure reducer: (state, event) → new state. Never mutates the input. */
export function apply(prev, e) {
  const s = structuredClone(prev);
  s.seq = e.seq;
  s.updatedAt = e.t;
  const step = e.step ? s.steps[e.step] : null;
  switch (e.event) {
    case "saga.start":
      s.id = e.saga;
      s.status = "running";
      s.network = e.network;
      s.account = e.account;
      s.params = e.params;
      s.startedAt = e.t;
      s.start = e.start ?? null;
      s.order = e.plan.map((p) => p.id);
      for (const p of e.plan) s.steps[p.id] = emptyStep(p.id, p.title, "forward");
      break;
    case "saga.resume":
      if (["paused", "running"].includes(s.status)) s.status = s.compensation.length ? "compensating" : "running";
      break;
    case "step.start":
      step.status = "running";
      step.attempts = e.attempt;
      if (e.title) step.title = e.title;
      step.error = null;
      s.current = { step: e.step, phase: step.phase, attempt: e.attempt };
      break;
    case "step.skip":
      step.status = "skipped";
      step.skipReason = e.reason;
      if (e.facts) Object.assign(step.facts, e.facts), Object.assign(s.facts, e.facts);
      break;
    case "gas.wait":
      step.status = "waiting-gas";
      break;
    case "tx.sent":
      step.status = "submitted";
      step.txs.push({ hash: e.hash, nonce: e.nonce, maxFeePerGas: e.maxFeePerGas, maxPriorityFeePerGas: e.maxPriorityFeePerGas, replaces: e.replaces ?? null, t: e.t });
      break;
    case "tx.dropped":
      for (const tx of step.txs) if (tx.hash === e.hash) tx.dropped = true;
      break;
    case "receipt":
      step.status = e.status === "success" ? "confirmed" : "failed";
      // A tx whose receipt was handled is settled: a later attempt must not pick it up again.
      for (const tx of step.txs) if (tx.hash === e.hash || tx.nonce === step.txs.find((x) => x.hash === e.hash)?.nonce) tx.settled = true;
      step.receipt = { hash: e.hash, block: e.block, gasUsed: e.gasUsed, effectiveGasPrice: e.effectiveGasPrice, status: e.status };
      break;
    case "mcp.check":
      step.checks.push({ label: "Chain MCP receipt", ok: e.ok, detail: e.detail });
      break;
    case "step.verified":
      step.status = "verified";
      step.checks.push(...e.checks);
      Object.assign(step.facts, e.facts);
      Object.assign(s.facts, e.facts);
      break;
    case "step.failed":
      step.status = "failed";
      step.error = { kind: e.kind, transient: e.transient, message: e.message, attempt: e.attempt };
      if (e.checks) step.checks.push(...e.checks);
      break;
    case "step.retry":
      step.status = "pending";
      break;
    case "saga.compensating":
      s.status = "compensating";
      s.failure = { step: e.failedStep, kind: e.reason, message: e.message };
      for (const c of e.plan) {
        if (!s.steps[c.id]) s.steps[c.id] = emptyStep(c.id, c.title, "compensation");
        if (!s.compensation.includes(c.id)) s.compensation.push(c.id);
      }
      for (const id of e.undone ?? []) if (s.steps[id]) s.steps[id].undoneBy = e.plan.filter((c) => c.undoes === id).map((c) => c.id);
      break;
    case "inject":
      s.injected.push({ step: e.step, kind: e.kind, detail: e.detail });
      break;
    case "saga.paused":
      s.status = "paused";
      s.failure = { step: e.step, kind: e.reason, message: e.message };
      break;
    case "saga.done":
      s.status = e.status;
      s.end = e.end ?? null;
      s.current = null;
      if (e.status === "compensated") for (const id of s.order) if (s.steps[id].status === "verified") s.steps[id].status = "compensated";
      break;
    default:
      break;
  }
  return s;
}

export const replay = (events) => events.reduce(apply, initialState());

/** In-memory log; `sink(entry)` persists each event (file, HTTP stream…) as it happens. */
export class StateLog {
  constructor({ sagaId, events = [], sink = () => {}, now = () => new Date().toISOString(), onChange = () => {} } = {}) {
    this.sagaId = sagaId;
    this.events = [...events];
    this.state = replay(this.events);
    this.sink = sink;
    this.now = now;
    this.onChange = onChange;
  }

  append(event, data = {}) {
    const entry = { seq: this.events.length + 1, t: this.now(), saga: this.sagaId, event, ...data };
    this.events.push(entry);
    this.state = apply(this.state, entry);
    this.sink(entry);
    this.onChange(entry, this.state);
    return entry;
  }
}

/** Where the saga is right now, in one line (what `saga status` prints first). */
export function whereNow(state) {
  if (!state.id) return "no saga";
  if (state.current) {
    const st = state.steps[state.current.step];
    const tx = st.txs.at(-1);
    return `${state.status.toUpperCase()} · ${state.current.phase === "compensation" ? "compensation" : "step"} ${state.current.step} · ${st.status}${tx ? ` · tx ${tx.hash.slice(0, 10)}… nonce ${tx.nonce}` : ""} · attempt ${st.attempts}`;
  }
  return state.status.toUpperCase();
}
