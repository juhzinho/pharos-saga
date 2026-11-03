import { explorerTx } from "./contracts.js";
import { whereNow } from "./log.js";
import { fmt } from "./steps.js";

// Human output for the CLI. One line per event, in the order they happened, plus a status table.

const time = (t) => t.slice(11, 19);
const pad = "           ";
const num = (v) => BigInt(v).toLocaleString("en-US");
const gwei = (v) => `${(Number(BigInt(v)) / 1e9).toFixed(2).replace(/\.00$/, "")} gwei`;

export function stepLabel(state, id) {
  const fwd = state.order.indexOf(id);
  if (fwd >= 0) return `step ${fwd + 1}/${state.order.length} ${id}`;
  const c = state.compensation.indexOf(id);
  return `undo ${c + 1}/${state.compensation.length} ${id}`;
}

export function renderEvent(e, state, { explorer = false } = {}) {
  const at = `[${time(e.t)}]`;
  const link = (h) => (explorer ? explorerTx(h) : h);
  switch (e.event) {
    case "saga.start":
      return [
        `${at} SAGA ${e.saga} on ${e.network === "pacific" ? "Pharos Pacific Mainnet" : "a local fork of Pharos Pacific Mainnet"}`,
        `${pad}account ${e.account} · ${fmt.pros(e.params.amount)} → ${e.params.vault.name} · on failure: ${e.params.compensation}${e.params.fail ? ` · FORCED FAILURE at ${e.params.fail}` : ""}`,
        `${pad}start balances: ${fmt.pros(e.start.pros)} · ${fmt.wpros(e.start.wpros)} · ${fmt.usdc(e.start.usdc)} · ${fmt.shares(e.start.shares, e.params.vault.symbol)}`,
        `${pad}plan: ${e.plan.map((p) => p.id).join(" → ")}`,
      ];
    case "saga.resume":
      return [`${at} RESUME from ${e.from}${e.step ? ` (was in ${e.step})` : ""}: rebuilt the state from the log`];
    case "step.start":
      return [`${at} ▶ ${stepLabel(state, e.step)} · attempt ${e.attempt}/${state.params.maxAttempts} · ${state.steps[e.step].title}`];
    case "step.reconciled":
      return [`${pad}↺ ${e.detail} (${e.hash.slice(0, 12)}…)`];
    case "step.prepared":
      return [`${pad}amount: ${e.detail}`];
    case "step.skip":
      return [`${pad}⤼ skipped: ${e.reason}`];
    case "step.simulated":
      return [e.predictsRevert ? `${pad}simulation predicts a revert (${e.reason}) · ${e.note}` : `${pad}simulated ok · gas ${num(e.gasEstimate)} → limit ${num(e.gasLimit)}${e.note ? ` · ${e.note}` : ""}`];
    case "gas.wait":
      return [`${pad}⏸ gas spike: base fee ${e.baseFeeGwei} gwei > cap ${e.capGwei} gwei · ${e.detail}`];
    case "tx.sent":
      return [`${pad}tx ${link(e.hash)} · nonce ${e.nonce} · max fee ${gwei(e.maxFeePerGas)}${e.replaces ? ` · replaces ${e.replaces.slice(0, 10)}… (same nonce)` : ""}${state.steps[e.step].txs.filter((x) => x.hash === e.hash).length > 1 ? " · the same signed tx as before (identical hash), now actually broadcast" : ""}`];
    case "inject":
      return [`${pad}⚡ injected ${e.kind}: ${e.detail}`];
    case "tx.dropped":
      return [`${pad}✗ dropped ${e.hash.slice(0, 12)}…: ${e.detail}`];
    case "receipt":
      return [`${pad}receipt · block ${num(e.block)} · ${e.status} · gas ${num(e.gasUsed)}`];
    case "mcp.check":
      return [`${pad}${e.ok ? "✓" : e.ok === false ? "✗" : "·"} Chain MCP: ${e.detail}`];
    case "step.verified":
      return [...e.checks.map((c) => `${pad}${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`), `${pad}VERIFIED`];
    case "step.failed":
      return [`${pad}✗ ${e.transient ? "transient" : "permanent"} failure (${e.kind}): ${e.message}`, ...(e.checks ?? []).filter((c) => !c.ok).map((c) => `${pad}  ✗ ${c.label} — ${c.detail}`)];
    case "step.retry":
      return [`${pad}↻ retry policy: attempt ${e.nextAttempt} in ${(e.delayMs / 1000).toFixed(1)} s`];
    case "step.requote":
      return [`${pad}↻ retry policy: the swap returned less than its minimum, re-quoting once (${e.requote})`];
    case "saga.compensating":
      return [`${at} COMPENSATE: ${e.failedStep} failed permanently (${e.reason}). Undo in reverse order: ${e.plan.map((p) => p.id).join(" → ") || "nothing to undo"}`];
    case "saga.paused":
      return [`${at} PAUSED at ${e.step}: ${e.message}`];
    case "saga.done":
      return renderDone(e, state, { explorer });
    default:
      return [];
  }
}

function renderDone(e, state) {
  const d = e.end.delta;
  const sym = state.params.vault.symbol;
  const sign = (v, f) => (BigInt(v) >= 0n ? "+" : "-") + f(BigInt(v) < 0n ? -BigInt(v) : BigInt(v));
  const head = { completed: "COMPLETED", compensated: "COMPENSATED (rolled back cleanly)", stuck: "STUCK — needs attention" }[e.status] ?? e.status;
  return [
    `[${time(e.t)}] ${head}`,
    `${pad}change: ${sign(d.pros, fmt.pros)} · ${sign(d.wpros, fmt.wpros)} · ${sign(d.usdc, fmt.usdc)} · ${sign(d.shares, (v) => fmt.shares(v, sym))}`,
    `${pad}gas paid: ${fmt.pros(e.end.gasWei)}${BigInt(e.end.marketCostWei ?? 0) > 0n ? ` · swap round-trip cost (0.01% pool fee + 0.15% FaroSwap route fee, both ways, + price impact): ${fmt.pros(e.end.marketCostWei)}` : ""}`,
    ...e.end.invariants.map((i) => `${pad}${i.ok ? "✓" : "✗"} ${i.label}`),
    ...(e.problem ? [`${pad}problem: ${e.problem.step}: ${e.problem.message}`] : []),
  ];
}

export function renderStatus(state, { explorer = false } = {}) {
  const lines = [`${state.id} · ${state.network}`, `NOW: ${whereNow(state)}`, ""];
  const row = (id) => {
    const s = state.steps[id];
    const tx = s.receipt?.hash ?? s.txs.at(-1)?.hash;
    return `  ${stepLabel(state, id).padEnd(30)} ${s.status.padEnd(12)} ${s.attempts ? `try ${s.attempts}` : "      "}  ${tx ? (explorer ? explorerTx(tx) : tx) : ""}`;
  };
  lines.push(...state.order.map(row));
  if (state.compensation.length) lines.push("  — compensation —", ...state.compensation.map(row));
  return lines.join("\n");
}
