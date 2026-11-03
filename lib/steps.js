import { encodeFunctionData, formatUnits, isAddressEqual } from "viem";
import { ABI, FAROSWAP, TOKENS } from "./contracts.js";
import { encodeMixSwap, minAfterSlippage, simulateSwap } from "./quote.js";
import { allowanceAt, balanceAt, check, eventsOf, short, verifyApprove } from "./verify.js";

// The saga: PROS → WPROS → (approve) → FaroSwap → USDC → (approve) → Morpho vault shares.
// Each step: build() returns the transaction, verify() proves the on-chain effect from the receipt,
// precheck() makes the step idempotent (skips it when its effect is already on chain).
// Compensations are only registered for steps the saga itself executed and verified.

export const fmt = {
  pros: (v) => `${trim(formatUnits(BigInt(v), 18), 6)} PROS`,
  wpros: (v) => `${trim(formatUnits(BigInt(v), 18), 6)} WPROS`,
  usdc: (v) => `${trim(formatUnits(BigInt(v), 6), 6)} USDC`,
  shares: (v, sym) => `${trim(formatUnits(BigInt(v), 18), 6)} ${sym}`,
};
function trim(s, max) {
  const [i, f = ""] = s.split(".");
  const cut = f.slice(0, max).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : i;
}

const W = TOKENS.WPROS.address;
const U = TOKENS.USDC.address;
const DODO = FAROSWAP.dodoApprove;
const approveData = (spender, amount) => encodeFunctionData({ abi: ABI.erc20, functionName: "approve", args: [spender, BigInt(amount)] });
const big = (v) => BigInt(v ?? 0);

export const FORWARD = ["wrap", "approve-wpros", "swap", "approve-usdc", "deposit"];
export const FAIL_POINTS = ["swap", "deposit"];

/** Compensations a verified forward step registers, in the order they must run (the saga runs them LIFO overall). */
export function compensationsFor(stepId, policy) {
  switch (stepId) {
    case "wrap":
      return ["unwrap"];
    case "approve-wpros":
      return ["revoke-wpros"];
    case "swap":
      return policy === "unwind" ? ["approve-usdc-back", "swap-back"] : [];
    case "approve-usdc":
      return ["revoke-usdc"];
    default:
      return [];
  }
}

/** Reverse order over the steps the saga executed: the last thing done is the first undone. */
export function compensationPlan(state, policy) {
  const done = state.order.filter((id) => state.steps[id].status === "verified");
  const plan = [];
  for (const id of [...done].reverse()) for (const c of compensationsFor(id, policy)) plan.push({ id: c, undoes: id });
  return plan;
}

export function makeSteps(ctx) {
  const { client, me, params } = ctx;
  const amount = big(params.amount);
  const vault = params.vault.address;
  const vaultSym = params.vault.symbol;
  const facts = () => ctx.facts;
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const received = () => (facts().usdcOut ? fmt.usdc(facts().usdcOut) : "the USDC received in step 3");

  return {
    wrap: {
      title: `Wrap ${fmt.pros(amount)} into WPROS`,
      build: async () => ({ to: W, data: encodeFunctionData({ abi: ABI.wpros, functionName: "deposit" }), value: amount }),
      verify: async (r) => {
        const evs = eventsOf(r, W, ABI.wpros, "Deposit").filter((a) => isAddressEqual(a.dst, me));
        const before = await balanceAt(client, W, me, r.blockNumber - 1n);
        const after = await balanceAt(client, W, me, r.blockNumber);
        return {
          checks: [
            check("WPROS Deposit event", evs.some((a) => a.wad === amount), evs.length ? `wad ${evs[0].wad}` : "missing"),
            check("WPROS balance +amount", after - before === amount, `${fmt.wpros(before)} → ${fmt.wpros(after)}`),
          ],
          facts: { wrapped: amount.toString() },
        };
      },
    },

    "approve-wpros": {
      title: `Approve FaroSwap (DODOApprove ${short(DODO)}) to spend ${fmt.wpros(amount)}`,
      precheck: async () => {
        const a = await allowanceAt(client, W, me, DODO);
        return a >= amount ? { reason: `allowance already ${fmt.wpros(a)}` } : null;
      },
      build: async () => ({ to: W, data: approveData(DODO, amount) }),
      verify: async (r) => ({ checks: await verifyApprove(client, r, { token: W, owner: me, spender: DODO, amount, symbol: "WPROS" }), facts: {} }),
    },

    swap: {
      title: `Swap ${fmt.wpros(amount)} → USDC on FaroSwap (0.01% pool ${short(FAROSWAP.pool)})`,
      build: async ({ requote = 0 } = {}) => {
        const dl = deadline();
        const quoted = await simulateSwap(client, { from: me, direction: 0, amount, deadline: dl });
        // Forced failure: ask for twice the quote. The pool cannot pay it, so the proxy reverts on chain.
        const min = params.fail === "swap" ? quoted * 2n : minAfterSlippage(quoted, ctx.policy.slippageBps);
        return {
          to: FAROSWAP.routeProxy,
          data: encodeMixSwap({ fromToken: W, toToken: U, amount, expReturn: params.fail === "swap" ? quoted * 2n : quoted, minReturn: min, direction: 0, deadline: dl }),
          note: `quote ${fmt.usdc(quoted)} · min ${fmt.usdc(min)}${requote ? ` · re-quote ${requote}` : ""}${params.fail === "swap" ? " · FORCED FAILURE: min is 2× the quote" : ""}`,
          forceOnChain: params.fail === "swap",
          gas: params.fail === "swap" ? 400_000n : undefined,
          meta: { quoted: quoted.toString(), min: min.toString() },
        };
      },
      verify: async (r, built) => {
        const inUsdc = eventsOf(r, U, ABI.erc20, "Transfer").filter((a) => isAddressEqual(a.to, me));
        const outW = eventsOf(r, W, ABI.erc20, "Transfer").filter((a) => isAddressEqual(a.from, me));
        const before = await balanceAt(client, U, me, r.blockNumber - 1n);
        const after = await balanceAt(client, U, me, r.blockNumber);
        const got = after - before;
        const min = big(built.meta.min);
        return {
          checks: [
            check("WPROS left the wallet", outW.reduce((s, a) => s + a.value, 0n) === amount, fmt.wpros(outW.reduce((s, a) => s + a.value, 0n))),
            check("USDC Transfer to the wallet", inUsdc.length > 0, inUsdc.length ? fmt.usdc(inUsdc.reduce((s, a) => s + a.value, 0n)) : "missing"),
            check(`received ≥ min (${fmt.usdc(min)})`, got >= min, `received ${fmt.usdc(got)} (quote ${fmt.usdc(built.meta.quoted)})`),
          ],
          facts: { usdcOut: got.toString(), swapQuote: built.meta.quoted },
        };
      },
    },

    "approve-usdc": {
      title: () => `Approve ${params.vault.name} to spend ${received()}`,
      precheck: async () => {
        const a = await allowanceAt(client, U, me, vault);
        return a >= big(facts().usdcOut) ? { reason: `allowance already ${fmt.usdc(a)}` } : null;
      },
      build: async () => ({ to: U, data: approveData(vault, facts().usdcOut) }),
      verify: async (r) => ({ checks: await verifyApprove(client, r, { token: U, owner: me, spender: vault, amount: facts().usdcOut, symbol: "USDC" }), facts: {} }),
    },

    deposit: {
      title: () => `Deposit ${received()} into ${params.vault.name}`,
      build: async () => {
        const assets = big(facts().usdcOut) + (params.fail === "deposit" ? 1n : 0n);
        return {
          to: vault,
          data: encodeFunctionData({ abi: ABI.vault, functionName: "deposit", args: [assets, me] }),
          note: params.fail === "deposit" ? `FORCED FAILURE: deposits ${fmt.usdc(assets)}, 0.000001 USDC more than approved, so USDC.transferFrom reverts` : `assets ${fmt.usdc(assets)}`,
          forceOnChain: params.fail === "deposit",
          gas: params.fail === "deposit" ? 600_000n : undefined,
          meta: { assets: assets.toString() },
        };
      },
      verify: async (r) => {
        const evs = eventsOf(r, vault, ABI.vault, "Deposit").filter((a) => isAddressEqual(a.owner, me));
        const before = await balanceAt(client, vault, me, r.blockNumber - 1n);
        const after = await balanceAt(client, vault, me, r.blockNumber);
        const shares = after - before;
        const ev = evs[0];
        const worth = shares > 0n ? await client.readContract({ address: vault, abi: ABI.vault, functionName: "convertToAssets", args: [shares], blockNumber: r.blockNumber }) : 0n;
        return {
          checks: [
            check("vault Deposit event", ev && ev.assets === big(facts().usdcOut), ev ? `assets ${fmt.usdc(ev.assets)} · shares ${ev.shares}` : "missing"),
            check("share balance +shares", ev && shares === ev.shares && shares > 0n, `${fmt.shares(before, vaultSym)} → ${fmt.shares(after, vaultSym)}`),
            check("shares worth the deposit", worth > 0n, `worth ${fmt.usdc(worth)}`),
          ],
          facts: { shares: shares.toString(), sharesWorth: worth.toString() },
        };
      },
    },

    // ---------- compensations ----------
    "revoke-usdc": {
      title: `Revoke the vault's USDC allowance`,
      precheck: async () => ((await allowanceAt(client, U, me, vault)) === 0n ? { reason: "allowance already 0" } : null),
      build: async () => ({ to: U, data: approveData(vault, 0n) }),
      verify: async (r) => ({ checks: await verifyApprove(client, r, { token: U, owner: me, spender: vault, amount: 0n, symbol: "USDC" }), facts: {} }),
    },

    "approve-usdc-back": {
      title: `Approve FaroSwap to swap the saga's USDC back`,
      prepare: async () => {
        const now = await client.readContract({ address: U, abi: ABI.erc20, functionName: "balanceOf", args: [me] });
        ctx.sagaUsdc = now - big(ctx.start.usdc) > 0n ? now - big(ctx.start.usdc) : 0n;
        return `the saga's USDC: ${fmt.usdc(ctx.sagaUsdc)} (balance ${fmt.usdc(now)} − ${fmt.usdc(ctx.start.usdc)} held before the saga)`;
      },
      precheck: async () => {
        if (ctx.sagaUsdc === 0n) return { reason: "the saga holds no USDC to swap back" };
        const a = await allowanceAt(client, U, me, DODO);
        return a >= ctx.sagaUsdc ? { reason: `allowance already ${fmt.usdc(a)}` } : null;
      },
      build: async () => ({ to: U, data: approveData(DODO, ctx.sagaUsdc), meta: { amount: ctx.sagaUsdc.toString() } }),
      verify: async (r, built) => ({ checks: await verifyApprove(client, r, { token: U, owner: me, spender: DODO, amount: built.meta.amount, symbol: "USDC" }), facts: { usdcBack: built.meta.amount } }),
    },

    "swap-back": {
      title: `Swap the saga's USDC back to WPROS on FaroSwap`,
      prepare: async () => {
        const now = await client.readContract({ address: U, abi: ABI.erc20, functionName: "balanceOf", args: [me] });
        ctx.sagaUsdc = now - big(ctx.start.usdc) > 0n ? now - big(ctx.start.usdc) : 0n;
        return `the saga's USDC: ${fmt.usdc(ctx.sagaUsdc)} (balance ${fmt.usdc(now)} − ${fmt.usdc(ctx.start.usdc)} held before the saga)`;
      },
      precheck: async () => (ctx.sagaUsdc === 0n ? { reason: "no saga USDC left to swap back" } : null),
      build: async ({ requote = 0 } = {}) => {
        const dl = deadline();
        const quoted = await simulateSwap(client, { from: me, direction: 1, amount: ctx.sagaUsdc, deadline: dl });
        const min = minAfterSlippage(quoted, ctx.policy.slippageBps);
        return {
          to: FAROSWAP.routeProxy,
          data: encodeMixSwap({ fromToken: U, toToken: W, amount: ctx.sagaUsdc, expReturn: quoted, minReturn: min, direction: 1, deadline: dl }),
          note: `quote ${fmt.wpros(quoted)} · min ${fmt.wpros(min)}${requote ? ` · re-quote ${requote}` : ""}`,
          meta: { quoted: quoted.toString(), min: min.toString(), usdcIn: ctx.sagaUsdc.toString() },
        };
      },
      verify: async (r, built) => {
        const before = await balanceAt(client, W, me, r.blockNumber - 1n);
        const after = await balanceAt(client, W, me, r.blockNumber);
        const usdcAfter = await balanceAt(client, U, me, r.blockNumber);
        return {
          checks: [
            check(`WPROS received ≥ min (${fmt.wpros(built.meta.min)})`, after - before >= big(built.meta.min), `received ${fmt.wpros(after - before)}`),
            check("saga USDC fully swapped back", usdcAfter === big(ctx.start.usdc), `USDC ${fmt.usdc(usdcAfter)} (start ${fmt.usdc(ctx.start.usdc)})`),
          ],
          facts: { wprosBack: (after - before).toString() },
        };
      },
    },

    "revoke-wpros": {
      title: `Revoke FaroSwap's WPROS allowance`,
      precheck: async () => ((await allowanceAt(client, W, me, DODO)) === 0n ? { reason: "allowance already 0 (the swap used it exactly)" } : null),
      build: async () => ({ to: W, data: approveData(DODO, 0n) }),
      verify: async (r) => ({ checks: await verifyApprove(client, r, { token: W, owner: me, spender: DODO, amount: 0n, symbol: "WPROS" }), facts: {} }),
    },

    unwrap: {
      title: `Unwrap the saga's WPROS back to PROS`,
      prepare: async () => {
        const now = await client.readContract({ address: W, abi: ABI.erc20, functionName: "balanceOf", args: [me] });
        ctx.sagaWpros = now - big(ctx.start.wpros) > 0n ? now - big(ctx.start.wpros) : 0n;
        return `the saga's WPROS: ${fmt.wpros(ctx.sagaWpros)} (balance ${fmt.wpros(now)} − ${fmt.wpros(ctx.start.wpros)} held before the saga)`;
      },
      precheck: async () => (ctx.sagaWpros === 0n ? { reason: "the saga holds no WPROS" } : null),
      build: async () => ({ to: W, data: encodeFunctionData({ abi: ABI.wpros, functionName: "withdraw", args: [ctx.sagaWpros] }), meta: { wad: ctx.sagaWpros.toString() } }),
      verify: async (r, built) => {
        const wad = big(built.meta.wad);
        const evs = eventsOf(r, W, ABI.wpros, "Withdrawal").filter((a) => isAddressEqual(a.src, me));
        const after = await balanceAt(client, W, me, r.blockNumber);
        return {
          checks: [
            check("WPROS Withdrawal event", evs.some((a) => a.wad === wad), evs.length ? fmt.wpros(evs[0].wad) : "missing"),
            check("WPROS back to the starting balance", after === big(ctx.start.wpros), `${fmt.wpros(after)} (start ${fmt.wpros(ctx.start.wpros)})`),
          ],
          facts: { unwrapped: wad.toString() },
        };
      },
    },
  };
}

export const titleOf = (step) => (typeof step.title === "function" ? step.title() : step.title);
