// Retry policy of the saga. Pure functions, so every rule is unit-tested.
//
// TRANSIENT (retry the same step, same intent):
//   rpc        network error, timeout, HTTP 429/5xx, rate limit           → back off, try again
//   dropped    tx not mined before the receipt timeout and its nonce free → re-broadcast with the SAME nonce and a fee bump
//   nonce      "nonce too low" / "already known"                          → re-read the chain first (the tx may already be in)
//   underpriced replacement/fee too low                                   → bump fees and resend with the same nonce
//   gas-spike  network base fee above our cap                             → wait for it to drop (does not burn an attempt)
//   slippage   swap reverted only because the price moved                 → re-quote once, then permanent
// PERMANENT (stop the forward path and compensate):
//   revert     simulation or receipt shows a deterministic revert
//   verify     receipt succeeded but the on-chain effect is not what the step promised
//   exhausted  a transient error kept coming back after maxAttempts

export const DEFAULT_POLICY = Object.freeze({
  maxAttempts: 4, // per step, counting the first try
  backoffMs: 1500, // 1.5 s, 3 s, 6 s … (+ up to 20% jitter)
  backoffMaxMs: 15_000,
  receiptTimeoutMs: 45_000, // Pharos blocks are ~1 s; 45 s without a receipt means dropped or stuck
  feeBumpPct: 20, // replacement must beat the old fee by >= 10% on most clients; 20% is safe
  maxFeeGwei: 50, // never pay more than this per gas (Pacific base fee today: 10 gwei)
  gasWaitMs: 120_000, // how long to wait for a gas spike to pass before pausing the saga
  gasPollMs: 3_000,
  slippageBps: 100, // 1% minimum-return guard on swaps
  slippageRequotes: 1,
});

const RPC = /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR|timed? ?out|aborted|\b(429|500|502|503|504)\b|rate limit|too many requests|service unavailable|bad gateway/i;
const NONCE = /nonce too low|already known|known transaction|nonce has already been used/i;
const UNDERPRICED = /replacement (transaction )?underpriced|transaction underpriced|fee too low|max fee per gas less than block base fee|maxFeePerGas.*less than.*baseFee/i;
const SLIPPAGE = /return amount is not enough|too little received|insufficient output|min(imum)? ?return/i;
const REVERT = /revert|execution reverted|invalid opcode|out of gas|insufficient (funds|balance|allowance)|exceeds (balance|allowance)|SafeERC20|custom error/i;

// Custom errors seen on the saga's contracts (selector → name), so a revert reads as words, not hex.
export const KNOWN_ERRORS = {
  "0xe65b7a77": "TransferFromReverted() — the vault could not pull the USDC (allowance or balance too low)",
  "0x1eded19c": "TransferFromReturnedFalse()",
  "0xfb8f41b2": "ERC20InsufficientAllowance",
  "0xe450d38c": "ERC20InsufficientBalance",
  "0x9811e0c7": "ZeroShares()",
  "0x4616e4af": "AbsoluteCapExceeded() — the vault is full",
  "0x44e1772c": "RelativeCapExceeded() — the vault is full",
  "0x3ae58fe4": "EnterBlocked() — deposits are closed",
};

/** One clean reason: viem's call dumps ("Raw Call Arguments…") cut off, custom error selectors named. */
export function cleanReason(text) {
  let t = String(text ?? "")
    .split(/\s*(?:Raw Call Arguments|Estimate Gas Arguments|Request Arguments|Request body|Contract Call|Docs:|Version:|URL:)/)[0]
    .replace(/Execution reverted with reason:\s*/gi, "reverted: ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [...new Set(t.split(" | ").map((p) => p.trim().replace(/\.$/, "")))].filter(Boolean);
  t = parts.join(" | ");
  return t.replace(/custom error (0x[0-9a-f]{8})/gi, (m, sel) => (KNOWN_ERRORS[sel.toLowerCase()] ? `custom error ${KNOWN_ERRORS[sel.toLowerCase()]}` : m));
}

/** Joins viem's nested messages so the regexes see the real reason. */
export function errorText(error) {
  if (!error) return "";
  const parts = [error.shortMessage, error.message, error.details, error.cause?.shortMessage, error.cause?.message, error.cause?.details, error.cause?.cause?.message];
  return cleanReason([...new Set(parts.filter(Boolean))].join(" | "));
}

/**
 * Classifies an error raised while simulating or sending a step.
 * Order matters: a 503 that mentions "revert" in a proxy page is still a network error, so RPC goes first,
 * and a slippage revert is checked before the generic revert.
 */
export function classify(error) {
  if (error?.kind) return error; // already classified (SagaError)
  const text = errorText(error);
  // Pharos node code 80004: the sender has never been funded on this chain. Retrying cannot help.
  if (/INVALID_ACCOUNT_ADDRESS|errcode:\s*80004/i.test(text)) return { kind: "account", transient: false, text: `${text} (the sending account has never been funded on Pharos Pacific)` };
  if (UNDERPRICED.test(text)) return { kind: "underpriced", transient: true, text };
  if (NONCE.test(text)) return { kind: "nonce", transient: true, text };
  if (SLIPPAGE.test(text)) return { kind: "slippage", transient: true, text };
  if (RPC.test(text) && !/execution reverted|\breverted:/i.test(text)) return { kind: "rpc", transient: true, text };
  if (REVERT.test(text)) return { kind: "revert", transient: false, text };
  return { kind: "unknown", transient: false, text };
}

/** A failure the engine raises itself (dropped tx, failed verification, reverted receipt…). */
export class SagaError extends Error {
  constructor(kind, message, transient) {
    super(message);
    this.kind = kind;
    this.transient = transient;
    this.text = message;
  }
}

/** Delay before attempt `attempt` (1-based: attempt 2 waits backoffMs). */
export function backoff(attempt, policy = DEFAULT_POLICY, random = Math.random) {
  if (attempt <= 1) return 0;
  const base = Math.min(policy.backoffMs * 2 ** (attempt - 2), policy.backoffMaxMs);
  return Math.round(base * (1 + 0.2 * random()));
}

/** Fees for a replacement of a tx sent with `prev` fees: at least feeBumpPct above both fields, never above the cap. */
export function bumpFees(prev, policy = DEFAULT_POLICY) {
  const up = (v) => (BigInt(v) * BigInt(100 + policy.feeBumpPct) + 99n) / 100n;
  const cap = gwei(policy.maxFeeGwei);
  const maxFeePerGas = up(prev.maxFeePerGas);
  const maxPriorityFeePerGas = up(prev.maxPriorityFeePerGas === 0n ? 1n : prev.maxPriorityFeePerGas);
  return {
    maxFeePerGas: maxFeePerGas > cap ? cap : maxFeePerGas,
    maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas,
    capped: maxFeePerGas > cap,
  };
}

export const gwei = (n) => BigInt(Math.round(Number(n) * 1e9));

/** Fees for a first send given the latest base fee. Returns null when the base fee is above the cap (gas spike). */
export function initialFees(baseFee, priorityFee, policy = DEFAULT_POLICY) {
  const cap = gwei(policy.maxFeeGwei);
  if (BigInt(baseFee) > cap) return null;
  const tip = BigInt(priorityFee ?? 0n);
  // 2× base fee headroom like most wallets, capped.
  let maxFeePerGas = BigInt(baseFee) * 2n + tip;
  if (maxFeePerGas > cap) maxFeePerGas = cap;
  return { maxFeePerGas, maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip };
}

/** What the engine should do next after a classified failure on attempt `attempt`. */
export function decide(failure, attempt, { requotes = 0 } = {}, policy = DEFAULT_POLICY) {
  if (!failure.transient) return { action: "compensate", reason: failure.kind };
  if (failure.kind === "slippage") {
    return requotes < policy.slippageRequotes ? { action: "requote" } : { action: "compensate", reason: "slippage" };
  }
  if (attempt >= policy.maxAttempts) return { action: "compensate", reason: "exhausted" };
  return { action: "retry", delayMs: backoff(attempt + 1, policy) };
}
