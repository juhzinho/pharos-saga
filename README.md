# Pharos Saga Executor

A Skill that runs a **multi-step, dependent on-chain workflow on Pharos Pacific Mainnet**: every step is verified from its receipt before the next one starts, transient failures are retried under a defined policy, and a permanent failure **rolls the finished steps back** so funds never sit stranded halfway.

```
PROS ──wrap──▶ WPROS ──approve──▶ FaroSwap ──swap──▶ USDC ──approve──▶ Morpho vault ──deposit──▶ shares
```

Real contracts only: the official WPROS and USDC from the Pharos token registry, the FaroSwap DODORouteProxy and its WPROS/USDC 0.01% pool, and the RockawayX (or SharpByte) USDC vault on Morpho.

**Live demo:** https://pharos-saga.vercel.app — a live Pacific quote, plus a replay of every recorded run's state log.  
**Skill:** [`skill/pharos-saga/SKILL.md`](skill/pharos-saga/SKILL.md)

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | ≥ 3 dependent steps, each verified (receipt checked) before the next | **5** steps: wrap → approve → swap → approve → deposit. Each is simulated (`eth_estimateGas`), signed, broadcast, and its receipt is checked: `status`, the expected events decoded from the logs (WPROS `Deposit`, `Approval`, `Transfer`, the vault's ERC-4626 `Deposit`) and balances/allowances read **at the receipt's block and the block before**. On Pacific the Chain MCP must report the same receipt too. The next step's tx is only signed after `step.verified` (checked by the end-to-end test). |
| 02 | Defined retry policy for transient failures (gas spike, dropped tx…) | [`lib/policy.js`](lib/policy.js): RPC/429/5xx → backoff 1.5/3/6 s, 4 attempts · dropped (no receipt in 45 s, nonce free) → **same nonce**, +20% fees · `nonce too low` → reconcile receipts first · gas spike above the 50 gwei cap → wait without spending an attempt, pause after 2 min · swap below its minimum → re-quote once. |
| 03 | Defined compensation / rollback path when a step permanently fails, and a demo | LIFO undo of every step the saga executed: revoke the vault allowance → approve FaroSwap → swap the saga's USDC back → revoke the WPROS allowance → unwrap. Only the saga's own amounts (balance now − balance at the start). `--compensation park` stops in USDC instead. Demo: `--fail deposit` / `--fail swap` (real on-chain reverts). |
| 04 | State log showing exactly which step the saga is in at any time | Append-only `runs/local/<id>/events.jsonl`; the state is a pure fold of the events ([`lib/log.js`](lib/log.js)). `npm run saga -- status` prints `NOW: RUNNING · step swap · submitted · tx 0x… nonce 25 · attempt 1`; `watch` follows it live; the web page replays it event by event. |
| 05 | One fully successful run and one forced-failure run with recovery | Recorded in [`public/runs/`](public/runs) and viewable on the demo: success, forced failure → rollback, swap failure → re-quote → rollback, transient faults → retries, crash → resume. |

## Beyond the brief

- **Crash-safe, exactly once.** The tx hash is written to the log *before* broadcast. Kill the process at any point (`--inject crash@swap`), run `resume`: it finds the receipt of what was already sent and never sends it again.
- **Fault injection** that uses the real chain: `rpc@step` (503 before broadcast), `drop@step` (signed, never broadcast), `gas@step` (Anvil base fee forced to 200 gwei for 9 s), `crash@step`, `verify@step` (the tx is mined, then the balance read fails — the retry re-verifies the same receipt and never sends twice).
- **Final invariants.** Every run ends by re-reading balances and the three allowances and printing ✓/✗: *no USDC left behind, no WPROS left behind, no open allowances, back to PROS…*
- **Honest cost.** A rollback reports gas and the swap round-trip cost separately: the 0.01% pool fee plus the 0.15% FaroSwap route fee (`DODORouteProxy.routeFeeRate()` = 1.5e15, read on chain), both ways, plus price impact.
- **Idempotent steps.** An approval that already exists is skipped; skipped steps are never "undone" (the user's own approvals are left alone).
- **Readable reverts.** Custom errors are decoded, e.g. `TransferFromReverted()` from the Morpho vault.
- **SkillEngine-ready.** `SKILL.md` + references, and `npm run saga -- cast` prints the same five steps as Foundry `cast send` commands with live calldata.
- **Live data.** `npm run saga -- plan` and the demo quote the saga on Pacific right now (simulated mixSwap + `previewDeposit`).

## Architecture

```
tasks/saga/saga.js        CLI: run · status · watch · resume · plan · cast · export
lib/engine.js             the saga runner: precheck → build → simulate → fees → sign → log → broadcast → receipt → verify
                          reconcile (crash/drop), retry decisions, compensation, final invariants, fault injector
lib/steps.js              the 5 forward steps and 5 compensations: build(), verify(receipt), precheck(), prepare()
lib/policy.js             error classification, backoff, fee bump, decide()           — pure, unit-tested
lib/log.js                StateLog + pure reducer apply()/replay()                   — shared with the web page
lib/verify.js             event decoding, balances/allowances pinned to a block
lib/quote.js              FaroSwap mixSwap calldata and quotes by simulation
lib/chain.js · fork.js    Pacific / Anvil fork clients, local signer, gas-spike helper
lib/mcp.js                Chain MCP second opinion on every Pacific receipt
public/ + api/plan.js     the demo: live quote + state-log replay
skill/pharos-saga/        the Skill package
```

One step, in order: `step.start` → reconcile earlier txs → `prepare` (exact amounts) → `precheck` (skip if already done) → build (re-quotes the swap) → simulate → fees within the cap (or wait) → sign → **`tx.sent` logged** → broadcast → wait for the receipt (or replace with the same nonce) → `receipt` → Chain MCP check (Pacific) → verify → `step.verified`.

## Run it

Node.js 20.12+.

```bash
npm install
npm test                                   # unit tests (policy, reducer, encoding)
npm run test:fork                          # every scenario end-to-end on a fresh Anvil fork of Pacific (~1–2 min)

npm run saga -- plan --amount 2            # live quote on Pacific, no key
npm run saga -- run --amount 2             # success on a local fork of Pacific (Anvil starts by itself)
npm run saga -- run --amount 2 --fail deposit            # forced failure → rollback
npm run saga -- run --amount 2 --inject drop@swap --receipt-timeout 6
npm run saga -- run --amount 2 --inject crash@swap ; npm run saga -- resume latest
npm run saga -- status latest
npm run web                                # the demo at http://localhost:3070
```

On the real Pacific Mainnet (real funds, your key in `.env`, see `.env.example`):

```bash
npm run saga -- run --network pacific --amount 2 --yes
npm run saga -- run --network pacific --amount 2 --fail deposit --yes
npm run saga -- export latest pacific-forced-failure     # shows it on the demo with explorer links
```

| Option | Default | Meaning |
|---|---|---|
| `--network fork\|pacific` | fork | local Anvil fork of Pacific (test account) or Pacific Mainnet |
| `--amount` | 2 | PROS to put through the saga |
| `--vault rock\|sharp` | rock | RockawayX or SharpByte USDC vault (Morpho) |
| `--compensation unwind\|park` | unwind | back to PROS, or stop in USDC |
| `--fail swap\|deposit` | — | force a permanent on-chain failure |
| `--inject kind@step` | — | `rpc`, `drop`, `gas` (fork), `crash`, `verify` |
| `--receipt-timeout` | 45 | seconds before an unmined tx counts as dropped |
| `--max-fee` | 50 | gas price cap, gwei |
| `--slippage` | 100 | swap guard in basis points |
| `--yes` | — | required on Pacific |

Safety: the private key is read from `.env` by the script, never printed or logged; exported runs drop the signed raw transactions. On Pacific the amount is capped at 20 PROS unless `--max-amount` says otherwise.

## Why a fork for most demos

The fork is Anvil forking Pacific Mainnet at the latest block: the same bytecode, the same pool liquidity, the same vault state. It lets the demo force gas spikes and crashes and run with a test account. Anvil and not Hardhat because Pacific block headers have no `excessBlobGas` (Hardhat panics) and the Morpho V2 vaults need Cancun opcodes.

## Tests

- `npm test` — 23 unit tests: classification (incl. the Pharos `80004` unfunded-account error), backoff, fee bump, decisions, the reducer (incl. crash replay and settled replacements), the compensation plan, mixSwap calldata.
- `npm run test:fork` — 11 end-to-end cases on a fresh fork: success with ordering check, forced deposit failure, forced swap failure with a real re-quote (two different nonces), park policy, 503 + dropped + gas spike, crash → status → resume with exactly one deposit, a verification error after mining (re-verified, sent exactly once), option validation.
