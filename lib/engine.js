import { FAROSWAP, TOKENS } from "./contracts.js";
import { classify, decide, DEFAULT_POLICY, initialFees, bumpFees, SagaError } from "./policy.js";
import { readFees, anvil } from "./chain.js";
import { compensationPlan, FORWARD, makeSteps, titleOf } from "./steps.js";
import { allowanceAt, snapshot } from "./verify.js";

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deep copy with bigints as decimal strings, so every log line is plain JSON. */
export function plain(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/**
 * Fault injection for demos and tests. Nothing is injected unless a rule is given explicitly.
 *   rpc@step    the broadcast of that step fails once with "503 Service Unavailable" (the tx never leaves)
 *   drop@step   the tx is signed but never broadcast, as if the mempool dropped it
 *   gas@step    (fork only) the base fee spikes above the cap for `gasSpikeMs`, then returns to normal
 *   crash@step  the process stops right after that step's tx is broadcast, before its receipt
 *   verify@step the tx is mined, then reading balances to verify it fails once (the retry must not resend)
 */
export class Injector {
  constructor(rules = [], { gasSpikeMs = 9_000, onCrash = () => process.exit(137) } = {}) {
    this.rules = rules.map((r) => ({ ...r, used: false }));
    this.gasSpikeMs = gasSpikeMs;
    this.onCrash = onCrash;
  }

  static parse(list = []) {
    return list.map((s) => {
      const m = /^(rpc|drop|gas|crash|verify)@([a-z-]+)$/.exec(s);
      if (!m) throw new Error(`--inject must look like rpc@swap, drop@deposit, gas@approve-usdc, crash@swap or verify@swap (got "${s}")`);
      return { kind: m[1], step: m[2] };
    });
  }

  take(step, kind) {
    const rule = this.rules.find((r) => !r.used && r.step === step && r.kind === kind);
    if (!rule) return false;
    rule.used = true;
    return true;
  }
}

/**
 * Runs (or resumes) a saga. `log` is a StateLog: a fresh one starts the saga, one rebuilt from a file resumes it.
 * Returns the final state.
 */
export async function runSaga({ client, signer, log, params, network, policy = DEFAULT_POLICY, inject = new Injector(), mcp = null, sleep = sleepReal, onStepError = () => {} }) {
  const me = signer.address;
  const ctx = {
    client,
    me,
    params,
    policy,
    get facts() {
      return log.state.facts;
    },
    start: log.state.start,
  };
  const steps = makeSteps(ctx);
  const isFork = network.id === "fork";

  // ---------- start or resume ----------
  if (log.state.status === "new") {
    const start = await snapshot(client, me, params.vault.address);
    ctx.start = start;
    log.append("saga.start", plain({
      network: network.id,
      account: me,
      params: { amount: params.amount, vault: params.vault, slippageBps: policy.slippageBps, compensation: params.compensation, fail: params.fail ?? null, maxFeeGwei: policy.maxFeeGwei, maxAttempts: policy.maxAttempts, signer: signer.kind },
      plan: FORWARD.map((id) => ({ id, title: titleOf(steps[id]) })),
      start,
    }));
  } else if (["completed", "compensated", "stuck"].includes(log.state.status)) {
    return log.state;
  } else {
    log.append("saga.resume", { from: log.state.status, step: log.state.current?.step ?? null });
  }

  // ---------- one step, with retries ----------
  async function runStep(id) {
    const step = steps[id];
    let requotes = 0;
    let attempt = log.state.steps[id].attempts;
    for (;;) {
      attempt += 1;
      log.append("step.start", { step: id, attempt, title: titleOf(step) });
      try {
        const reconciled = await reconcile(id);
        if (reconciled) return await finish(id, reconciled.receipt, reconciled.built);

        const prepared = await step.prepare?.();
        if (prepared) log.append("step.prepared", { step: id, detail: prepared });
        const skip = await step.precheck?.();
        if (skip) {
          log.append("step.skip", { step: id, reason: skip.reason });
          return { ok: true };
        }

        if (inject.take(id, "gas")) await injectGasSpike(id);
        const built = await step.build({ requote: requotes });
        const gas = await simulate(id, built);
        const fees = await feesWithinCap(id);
        if (!fees) return { paused: true };
        const nonce = await client.getTransactionCount({ address: me, blockTag: "pending" });
        const receipt = await sendAndConfirm(id, built, { gas, fees, nonce });
        return await finish(id, receipt, built);
      } catch (error) {
        const f = classify(error);
        log.append("step.failed", { step: id, kind: f.kind, transient: f.transient, message: short(f.text), attempt, checks: error.checks ?? undefined });
        onStepError(id, f);
        const d = decide(f, attempt, { requotes }, policy);
        if (d.action === "requote") {
          requotes += 1;
          log.append("step.requote", { step: id, requote: requotes });
          continue;
        }
        if (d.action === "retry") {
          log.append("step.retry", { step: id, delayMs: d.delayMs, nextAttempt: attempt + 1 });
          await sleep(d.delayMs);
          continue;
        }
        return { failed: f, reason: d.reason };
      }
    }
  }

  /** A tx from an earlier attempt (or from before a crash) may already be mined: look before sending anything new. */
  async function reconcile(id) {
    const st = log.state.steps[id];
    const builtOf = (hash) => log.events.find((e) => e.event === "tx.sent" && e.hash === hash).built;
    // 1. A successful receipt was already handled but its verification did not finish (e.g. an RPC error while
    //    reading balances): verify that same receipt again. Sending a new tx here would execute the step twice.
    if (st.receipt?.status === "success") {
      const again = await client.getTransactionReceipt({ hash: st.receipt.hash });
      log.append("step.reconciled", { step: id, hash: st.receipt.hash, detail: "this step's tx is already mined successfully; verifying that receipt again instead of sending a new tx" });
      return { receipt: again, built: builtOf(st.receipt.hash) };
    }
    // 2. Txs whose receipt was never handled: the crash case (sent, then the process died before the receipt).
    //    "dropped" is only our belief, so a dropped tx that was mined late counts too.
    const live = st.txs.filter((t) => !t.settled);
    if (!live.length) return null;
    const found = await findReceipt(live.map((t) => t.hash));
    if (found) {
      const sent = log.events.find((e) => e.event === "tx.sent" && e.hash === found.transactionHash);
      log.append("step.reconciled", { step: id, hash: found.transactionHash, detail: "a transaction from an earlier attempt was already mined; using its receipt instead of sending again" });
      return { receipt: found, built: sent.built };
    }
    const nonce = live.at(-1).nonce;
    const latest = await client.getTransactionCount({ address: me, blockTag: "latest" });
    if (latest > nonce) {
      await sleep(2_000);
      const again = await findReceipt(live.map((t) => t.hash));
      if (again) {
        const sent = log.events.find((e) => e.event === "tx.sent" && e.hash === again.transactionHash);
        return { receipt: again, built: sent.built };
      }
      throw new SagaError("nonce-taken", `nonce ${nonce} was used by a transaction this saga did not send; stopping instead of guessing`, false);
    }
    for (const t of live.filter((x) => !x.dropped)) log.append("tx.dropped", { step: id, hash: t.hash, detail: "never mined and its nonce is still free, so sending again is safe" });
    return null;
  }

  async function findReceipt(hashes) {
    for (const hash of hashes) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        if (r) return r;
      } catch {}
    }
    return null;
  }

  async function simulate(id, built) {
    try {
      const est = await client.estimateGas({ account: me, to: built.to, data: built.data, value: built.value ?? 0n });
      const gas = (est * 130n) / 100n;
      log.append("step.simulated", { step: id, gasEstimate: est.toString(), gasLimit: gas.toString(), note: built.note ?? null });
      return built.gas ?? gas;
    } catch (error) {
      if (!built.forceOnChain) throw error;
      log.append("step.simulated", { step: id, predictsRevert: true, reason: short(classify(error).text), note: `${built.note ?? ""} · sending anyway so the revert is mined and caught by the receipt check` });
      return built.gas;
    }
  }

  async function feesWithinCap(id) {
    const startedAt = Date.now();
    let lastLog = 0;
    for (;;) {
      const { baseFee, priorityFee } = await readFees(client);
      const fees = initialFees(baseFee, priorityFee, policy);
      if (fees) return fees;
      if (Date.now() - lastLog > 10_000) {
        log.append("gas.wait", { step: id, baseFeeGwei: gweiStr(baseFee), capGwei: String(policy.maxFeeGwei), detail: "base fee above the cap; waiting (does not use an attempt)" });
        lastLog = Date.now();
      }
      if (Date.now() - startedAt > policy.gasWaitMs) {
        log.append("saga.paused", { step: id, reason: "gas-spike", message: `base fee stayed above ${policy.maxFeeGwei} gwei for ${Math.round(policy.gasWaitMs / 1000)} s. Every finished step left the funds in a valid state, so the saga pauses; run "resume" later.` });
        return null;
      }
      await sleep(policy.gasPollMs);
    }
  }

  async function injectGasSpike(id) {
    if (!isFork || !(await anvil.isAnvil(client))) {
      log.append("inject", { step: id, kind: "gas", detail: "skipped: a gas spike can only be injected on the local fork" });
      return;
    }
    const spike = BigInt(policy.maxFeeGwei) * 4n * 10n ** 9n;
    await anvil.spikeBaseFee(client, spike);
    log.append("inject", { step: id, kind: "gas", detail: `base fee forced to ${gweiStr(spike)} gwei on the fork for ${inject.gasSpikeMs / 1000} s` });
    setTimeout(() => anvil.spikeBaseFee(client, 10n ** 10n).catch(() => {}), inject.gasSpikeMs);
  }

  async function sendAndConfirm(id, built, { gas, fees, nonce }) {
    let current = fees;
    let replaces = null;
    const hashes = [];
    for (let round = 1; round <= 3; round++) {
      const tx = { to: built.to, data: built.data, value: built.value ?? 0n, gas, nonce, maxFeePerGas: current.maxFeePerGas, maxPriorityFeePerGas: current.maxPriorityFeePerGas };
      const { raw, hash } = await signer.sign(tx);
      hashes.push(hash);
      log.append("tx.sent", plain({ step: id, hash, nonce, maxFeePerGas: current.maxFeePerGas, maxPriorityFeePerGas: current.maxPriorityFeePerGas, gas, replaces, built: { to: built.to, data: built.data, value: built.value ?? 0n, note: built.note ?? null, meta: built.meta ?? {} }, raw }));

      if (inject.take(id, "rpc")) {
        log.append("inject", { step: id, kind: "rpc", detail: "broadcast failed with 503 Service Unavailable before reaching the node" });
        throw new SagaError("rpc", "503 Service Unavailable (injected)", true);
      }
      if (inject.take(id, "drop")) {
        log.append("inject", { step: id, kind: "drop", detail: "signed but never broadcast, as if the mempool dropped it" });
      } else {
        try {
          await signer.broadcast(raw);
        } catch (error) {
          const f = classify(error);
          if (f.kind === "underpriced") {
            current = bumpFees(current, policy);
            replaces = hash;
            continue;
          }
          if (f.kind !== "nonce") throw error;
        }
        if (inject.take(id, "crash")) {
          log.append("inject", { step: id, kind: "crash", detail: "process stopped right after the broadcast, before the receipt" });
          inject.onCrash();
          return await new Promise(() => {});
        }
      }

      const receipt = await waitReceipt(hashes);
      if (receipt) return receipt;
      const latest = await client.getTransactionCount({ address: me, blockTag: "latest" });
      if (latest > nonce) {
        const late = await findReceipt(hashes);
        if (late) return late;
        throw new SagaError("nonce-taken", `nonce ${nonce} was used by a transaction this saga did not send`, false);
      }
      log.append("tx.dropped", { step: id, hash, detail: `no receipt after ${policy.receiptTimeoutMs / 1000} s and nonce ${nonce} is still free: replacing it with the same nonce and +${policy.feeBumpPct}% fees, so only one can ever be mined` });
      current = bumpFees(current, policy);
      replaces = hash;
    }
    throw new SagaError("dropped", "transaction dropped three times", true);
  }

  async function waitReceipt(hashes) {
    const until = Date.now() + policy.receiptTimeoutMs;
    while (Date.now() < until) {
      const r = await findReceipt(hashes);
      if (r) return r;
      await sleep(1_000);
    }
    return null;
  }

  async function finish(id, receipt, built) {
    log.append("receipt", plain({ step: id, hash: receipt.transactionHash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, status: receipt.status }));
    if (mcp) {
      const m = await mcp.checkReceipt(receipt).catch((e) => ({ ok: null, detail: `Chain MCP unavailable: ${e.message}` }));
      log.append("mcp.check", { step: id, ok: m.ok, detail: m.detail });
      if (m.ok === false) throw new SagaError("verify", `Chain MCP disagrees with the RPC receipt: ${m.detail}`, false);
    }
    if (receipt.status !== "success") {
      const reason = await revertReason(built, receipt);
      const f = classify({ message: reason });
      throw new SagaError(f.kind === "slippage" ? "slippage" : "revert", `reverted on chain in block ${receipt.blockNumber}: ${reason}`, f.kind === "slippage");
    }
    if (inject.take(id, "verify")) {
      log.append("inject", { step: id, kind: "verify", detail: "the RPC failed with 503 while reading balances to verify the receipt" });
      throw new SagaError("rpc", "503 Service Unavailable while verifying (injected)", true);
    }
    const v = await steps[id].verify(receipt, built);
    if (!v.checks.every((c) => c.ok)) {
      const e = new SagaError("verify", `receipt succeeded but the effect does not match: ${v.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}`, false);
      e.checks = v.checks;
      throw e;
    }
    log.append("step.verified", plain({ step: id, checks: v.checks, facts: v.facts }));
    return { ok: true };
  }

  async function revertReason(built, receipt) {
    try {
      await client.call({ account: me, to: built.to, data: built.data, value: BigInt(built.value ?? 0), blockNumber: receipt.blockNumber - 1n });
      return "reverted (no reason returned)";
    } catch (e) {
      return short(classify(e).text) || "reverted";
    }
  }

  // ---------- forward path ----------
  if (log.state.status === "running" || log.state.status === "paused") {
    for (const id of FORWARD) {
      const st = log.state.steps[id].status;
      if (st === "verified" || st === "skipped") continue;
      const res = await runStep(id);
      if (res.paused) return log.state;
      if (res.failed) {
        const plan = compensationPlan(log.state, params.compensation).map((c) => ({ ...c, title: titleOf(steps[c.id]) }));
        log.append("saga.compensating", { failedStep: id, reason: res.reason, message: short(res.failed.text), plan, undone: [...new Set(plan.map((c) => c.undoes))] });
        break;
      }
    }
    if (log.state.status === "running") return finalize("completed");
  }

  // ---------- compensation path (LIFO) ----------
  if (log.state.status === "compensating") {
    for (const id of log.state.compensation) {
      const st = log.state.steps[id].status;
      if (st === "verified" || st === "skipped") continue;
      const res = await runStep(id);
      if (res.paused) return log.state;
      if (res.failed) return finalize("stuck", { step: id, message: short(res.failed.text) });
    }
    return finalize("compensated");
  }
  return log.state;

  async function finalize(status, problem = null) {
    const end = await snapshot(client, me, params.vault.address);
    const [wprosDodo, usdcDodo, usdcVault] = await Promise.all([
      allowanceAt(client, TOKENS.WPROS.address, me, FAROSWAP.dodoApprove),
      allowanceAt(client, TOKENS.USDC.address, me, FAROSWAP.dodoApprove),
      allowanceAt(client, TOKENS.USDC.address, me, params.vault.address),
    ]);
    const start = log.state.start;
    const d = (k) => BigInt(end[k]) - BigInt(start[k]);
    // Gas of every mined tx, reverted ones included (a step that retried can have several receipts).
    const seen = new Set();
    const gasWei = log.events.filter((e) => e.event === "receipt" && !seen.has(e.hash) && seen.add(e.hash)).reduce((s, e) => s + BigInt(e.gasUsed) * BigInt(e.effectiveGasPrice ?? 0), 0n);
    const noAllowances = wprosDodo === 0n && usdcDodo === 0n && usdcVault === 0n;
    const invariants =
      status === "completed"
        ? [
            ["vault shares received", d("shares") > 0n],
            ["no USDC left behind", d("usdc") === 0n],
            ["no WPROS left behind", d("wpros") === 0n],
            ["no open allowances", noAllowances],
          ]
        : status === "compensated"
          ? params.compensation === "unwind"
            ? [
                ["back to PROS: WPROS as at start", d("wpros") === 0n],
                ["back to PROS: USDC as at start", d("usdc") === 0n],
                ["no vault shares created", d("shares") === 0n],
                ["no open allowances", noAllowances],
              ]
            : [
                ["parked in USDC, nothing else stranded", d("wpros") === 0n && d("shares") === 0n],
                ["no open allowances", noAllowances],
              ]
          : [["needs attention", false]];
    log.append("saga.done", plain({
      status,
      problem,
      end: {
        balances: end,
        delta: { pros: d("pros"), wpros: d("wpros"), usdc: d("usdc"), shares: d("shares") },
        allowances: { wprosToFaroSwap: wprosDodo, usdcToFaroSwap: usdcDodo, usdcToVault: usdcVault },
        gasWei,
        // PROS change not explained by gas = what the swaps cost (pool fee + price impact); 0 on a completed run.
        marketCostWei: status === "compensated" && params.compensation === "unwind" ? -d("pros") - gasWei : 0n,
        invariants: invariants.map(([label, ok]) => ({ label, ok })),
      },
    }));
    return log.state;
  }
}

const short = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 400);
const gweiStr = (wei) => (Number(BigInt(wei)) / 1e9).toFixed(2).replace(/\.00$/, "");
