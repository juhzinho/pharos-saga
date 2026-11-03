# Compensation

When a step fails permanently, the saga undoes the steps **it executed and verified**, last first.

| Forward step | Its compensation |
|---|---|
| wrap | unwrap the saga's WPROS (`withdraw`) |
| approve-wpros | revoke (approve 0), skipped when the swap already used it exactly |
| swap | approve FaroSwap for the saga's USDC → swap it back to WPROS (unwind policy only) |
| approve-usdc | revoke the vault's allowance |
| deposit | — (last step; a verified deposit ends the saga) |

Rules:

- **Only the saga's own funds.** Amounts are "balance now − balance at the start of the saga". Tokens the wallet held before are never touched.
- **Only the saga's own approvals.** A step skipped because the user already had an approval registers no compensation.
- **Same guarantees as forward steps.** Each compensation is simulated, receipt-checked and verified, with the same retry policy.
- **Final invariants.** At the end the saga reads balances and the three allowances again and prints ✓/✗ for each promise (e.g. "back to PROS: USDC as at start", "no open allowances").
- **Cost is reported.** For an unwind, the PROS difference is split into gas and the swap round-trip cost: the 0.01% pool fee plus the 0.15% FaroSwap route fee (`DODORouteProxy.routeFeeRate()`), both ways, plus price impact.
- If a compensation itself fails permanently, the saga ends **STUCK** with the step and the reason, instead of improvising.

Policies: `--compensation unwind` (default, back to PROS) or `--compensation park` (stop in USDC, the stable asset, without paying for a second swap).

## Forcing a failure for a demo

- `--fail deposit`: the deposit asks for 0.000001 USDC more than was approved. The real vault reverts on chain with `TransferFromReverted()`; the saga mines it on purpose so the **receipt check** catches it.
- `--fail swap`: the swap's minimum is set to 2× the quote. FaroSwap reverts with `Return amount is not enough`; the saga re-quotes once (still forced), then compensates.
