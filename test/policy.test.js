import test from "node:test";
import assert from "node:assert/strict";
import { backoff, bumpFees, classify, cleanReason, decide, DEFAULT_POLICY, gwei, initialFees, SagaError } from "../lib/policy.js";

test("network errors are transient, reverts are permanent", () => {
  assert.equal(classify(new Error("fetch failed")).kind, "rpc");
  assert.equal(classify(new Error("HTTP request failed. Status: 503")).kind, "rpc");
  assert.equal(classify(new Error("429 Too Many Requests")).transient, true);
  assert.equal(classify(new Error("execution reverted: custom error 0xe65b7a77")).kind, "revert");
  assert.equal(classify(new Error("execution reverted: custom error 0xe65b7a77")).transient, false);
});

test("a revert behind a 5xx-looking proxy message is still a revert", () => {
  assert.equal(classify(new Error("Execution reverted with reason: x (status 500)")).kind, "revert");
});

test("nonce, underpriced and slippage are recognised", () => {
  assert.equal(classify(new Error("nonce too low")).kind, "nonce");
  assert.equal(classify(new Error("already known")).kind, "nonce");
  assert.equal(classify(new Error("replacement transaction underpriced")).kind, "underpriced");
  assert.equal(classify(new Error("max fee per gas less than block base fee")).kind, "underpriced");
  const s = classify(new Error("reverted: DODORouteProxy: Return amount is not enough"));
  assert.equal(s.kind, "slippage");
  assert.equal(s.transient, true);
});

test("Pharos 80004 (unfunded account) is permanent, not a network error", () => {
  const c = classify(new Error("errcode: 80004, errmsg: INVALID_ACCOUNT_ADDRESS"));
  assert.equal(c.kind, "account");
  assert.equal(c.transient, false);
  assert.match(c.text, /never been funded/);
});

test("SagaError keeps its own classification", () => {
  const e = new SagaError("dropped", "gone", true);
  assert.equal(classify(e).kind, "dropped");
});

test("custom error selectors become words and call dumps are cut", () => {
  const r = cleanReason("Execution reverted with reason: custom error 0xe65b7a77. | Execution reverted with reason: custom error 0xe65b7a77. Raw Call Arguments: from: 0x1 data: 0x2");
  assert.match(r, /^reverted: custom error TransferFromReverted\(\)/);
  assert.doesNotMatch(r, /Raw Call|\|/);
});

test("backoff doubles, is capped and has bounded jitter", () => {
  assert.equal(backoff(1), 0);
  assert.equal(backoff(2, DEFAULT_POLICY, () => 0), 1500);
  assert.equal(backoff(3, DEFAULT_POLICY, () => 0), 3000);
  assert.equal(backoff(4, DEFAULT_POLICY, () => 0), 6000);
  assert.equal(backoff(20, DEFAULT_POLICY, () => 0), 15000);
  assert.equal(backoff(2, DEFAULT_POLICY, () => 1), 1800);
});

test("initial fees: 2× base fee + tip, null above the cap (gas spike)", () => {
  assert.deepEqual(initialFees(gwei(10), 0n), { maxFeePerGas: gwei(20), maxPriorityFeePerGas: 0n });
  assert.equal(initialFees(gwei(200), 0n), null);
  assert.deepEqual(initialFees(gwei(40), 0n), { maxFeePerGas: gwei(50), maxPriorityFeePerGas: 0n });
});

test("replacement fees beat the old ones by 20% and respect the cap", () => {
  const b = bumpFees({ maxFeePerGas: gwei(20), maxPriorityFeePerGas: 0n });
  assert.equal(b.maxFeePerGas, gwei(24));
  assert.ok(b.maxPriorityFeePerGas > 0n, "a 0 tip is bumped to a positive one so the replacement is accepted");
  const capped = bumpFees({ maxFeePerGas: gwei(48), maxPriorityFeePerGas: gwei(1) });
  assert.equal(capped.maxFeePerGas, gwei(50));
  assert.equal(capped.capped, true);
});

test("decide: retry transient, requote slippage once, compensate the rest", () => {
  assert.equal(decide({ kind: "rpc", transient: true }, 1).action, "retry");
  assert.equal(decide({ kind: "rpc", transient: true }, DEFAULT_POLICY.maxAttempts).action, "compensate");
  assert.equal(decide({ kind: "rpc", transient: true }, DEFAULT_POLICY.maxAttempts).reason, "exhausted");
  assert.equal(decide({ kind: "slippage", transient: true }, 1, { requotes: 0 }).action, "requote");
  assert.equal(decide({ kind: "slippage", transient: true }, 2, { requotes: 1 }).action, "compensate");
  assert.equal(decide({ kind: "revert", transient: false }, 1).action, "compensate");
});
