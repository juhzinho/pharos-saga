import test from "node:test";
import assert from "node:assert/strict";
import { StateLog, replay, whereNow } from "../lib/log.js";
import { compensationPlan, compensationsFor, FORWARD } from "../lib/steps.js";

const plan = FORWARD.map((id) => ({ id, title: id }));
const start = { pros: "10", wpros: "0", usdc: "0", shares: "0" };
const clock = () => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 10, 3, 12, 0, n++)).toISOString();
};

function begin() {
  const log = new StateLog({ sagaId: "t", now: clock() });
  log.append("saga.start", { network: "fork", account: "0xabc", params: { amount: "1", compensation: "unwind", maxAttempts: 4 }, plan, start });
  return log;
}

test("a fresh saga has every step pending", () => {
  const s = begin().state;
  assert.equal(s.status, "running");
  assert.deepEqual(s.order, FORWARD);
  assert.ok(FORWARD.every((id) => s.steps[id].status === "pending"));
});

test("the state is a pure fold: replaying the events gives the same state", () => {
  const log = begin();
  log.append("step.start", { step: "wrap", attempt: 1 });
  log.append("tx.sent", { step: "wrap", hash: "0x1", nonce: 0 });
  log.append("receipt", { step: "wrap", hash: "0x1", block: "5", gasUsed: "1", status: "success" });
  log.append("step.verified", { step: "wrap", checks: [{ label: "x", ok: true }], facts: { wrapped: "1" } });
  assert.deepEqual(replay(log.events), log.state);
  assert.equal(log.state.facts.wrapped, "1");
});

test("after a crash the replayed state shows the submitted tx, not settled", () => {
  const log = begin();
  log.append("step.start", { step: "wrap", attempt: 1 });
  log.append("tx.sent", { step: "wrap", hash: "0xaa", nonce: 7 });
  const s = replay(log.events);
  assert.equal(s.steps.wrap.status, "submitted");
  assert.equal(s.steps.wrap.txs[0].settled, undefined);
  assert.match(whereNow(s), /step wrap · submitted · tx 0xaa… nonce 7/);
});

test("a handled receipt settles its tx and its replacements (same nonce)", () => {
  const log = begin();
  log.append("step.start", { step: "swap", attempt: 1 });
  log.append("tx.sent", { step: "swap", hash: "0x1", nonce: 3 });
  log.append("tx.dropped", { step: "swap", hash: "0x1" });
  log.append("tx.sent", { step: "swap", hash: "0x2", nonce: 3, replaces: "0x1" });
  log.append("receipt", { step: "swap", hash: "0x2", block: "9", gasUsed: "1", status: "reverted" });
  assert.equal(log.state.steps.swap.status, "failed");
  assert.ok(log.state.steps.swap.txs.every((t) => t.settled));
});

test("compensation is the reverse of the verified steps, skipped steps are not undone", () => {
  const log = begin();
  for (const id of ["wrap", "approve-wpros", "swap", "approve-usdc"]) log.append("step.verified", { step: id, checks: [], facts: {} });
  assert.deepEqual(
    compensationPlan(log.state, "unwind").map((c) => c.id),
    ["revoke-usdc", "approve-usdc-back", "swap-back", "revoke-wpros", "unwrap"]
  );
  assert.deepEqual(compensationPlan(log.state, "park").map((c) => c.id), ["revoke-usdc", "revoke-wpros", "unwrap"]);

  const skipped = begin();
  skipped.append("step.verified", { step: "wrap", checks: [], facts: {} });
  skipped.append("step.skip", { step: "approve-wpros", reason: "already approved" });
  assert.deepEqual(compensationPlan(skipped.state, "unwind").map((c) => c.id), ["unwrap"], "a pre-existing approval is the user's, so the saga leaves it");
});

test("each forward step registers the right undo", () => {
  assert.deepEqual(compensationsFor("deposit", "unwind"), []);
  assert.deepEqual(compensationsFor("swap", "unwind"), ["approve-usdc-back", "swap-back"]);
  assert.deepEqual(compensationsFor("swap", "park"), []);
});

test("compensating → done marks forward work as compensated", () => {
  const log = begin();
  log.append("step.verified", { step: "wrap", checks: [], facts: {} });
  log.append("saga.compensating", { failedStep: "approve-wpros", reason: "revert", plan: [{ id: "unwrap", undoes: "wrap", title: "unwrap" }], undone: ["wrap"] });
  assert.equal(log.state.status, "compensating");
  assert.deepEqual(log.state.compensation, ["unwrap"]);
  log.append("step.verified", { step: "unwrap", checks: [], facts: {} });
  log.append("saga.done", { status: "compensated", end: {} });
  assert.equal(log.state.steps.wrap.status, "compensated");
  assert.equal(log.state.current, null);
});

test("resume after a pause continues the same phase", () => {
  const log = begin();
  log.append("saga.paused", { step: "swap", reason: "gas-spike", message: "x" });
  assert.equal(log.state.status, "paused");
  log.append("saga.resume", { from: "paused" });
  assert.equal(log.state.status, "running");
});
