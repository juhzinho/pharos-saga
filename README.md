# Pharos Saga Executor

A Skill that runs a **multi-step, dependent on-chain workflow on Pharos Pacific Mainnet**: every step is verified from its receipt before the next one starts, transient failures are retried under a defined policy, and a permanent failure **rolls the finished steps back** so funds never sit stranded halfway.

```
PROS ──wrap──▶ WPROS ──approve──▶ FaroSwap ──swap──▶ USDC ──approve──▶ Morpho vault ──deposit──▶ shares
```

Real contracts only: the official WPROS and USDC from the Pharos token registry, the FaroSwap DODORouteProxy and its WPROS/USDC 0.01% pool, and the RockawayX (or SharpByte) USDC vault on Morpho.

**Live demo:** https://pharos-saga.vercel.app — a live Pacific quote, plus a replay of every recorded run's state log.  
**Skill:** [`skill/pharos-saga/SKILL.md`](skill/pharos-saga/SKILL.md)

## Real runs on Pharos Atlantic Testnet

Both required runs happened **on chain**, on Pharos Atlantic Testnet (chain 688689), and every transaction below opens on the explorer. FaroSwap and Morpho are not deployed on Atlantic, so the saga runs against **test contracts with the same interfaces** ([`contracts/atlantic/SagaTest.sol`](contracts/atlantic/SagaTest.sol), deployed by [`scripts/deploy-atlantic.mjs`](scripts/deploy-atlantic.mjs)); the saga engine, the retry policy, the compensation and the state log are the same code that runs on Pacific.

| Test contract | Address | Stands in for |
|---|---|---|
| `SagaWPHRS` (WETH9-style) | [`0x4c51…f81f`](https://atlantic.pharosscan.xyz/address/0x4c51c7424f7425f26bcf2e405a3e9ea82449f81f) | WPROS |
| `SagaTestRouter` (FaroSwap `mixSwap` signature, one x·y=k WPHRS/tUSDC pool, 0.3% fee) | [`0x5c05…3ef8`](https://atlantic.pharosscan.xyz/address/0x5c05f3afd4104c04850f142d4104a54f3aba3ef8) | FaroSwap DODORouteProxy + pool |
| `SagaTestVault` (OpenZeppelin ERC-4626) | [`0xc4e7…4068`](https://atlantic.pharosscan.xyz/address/0xc4e75cc425111c917aafa52998079f932b4b4068) | Morpho USDC vault |
| `SagaTestUSDC` (6 decimals, EIP-3009 like Circle USDC) | [`0x6ff6…16e3`](https://atlantic.pharosscan.xyz/address/0x6ff683573da87b2833f42c30fc8cefb60ecd16e3) | USDC |

The stablecoin is a test token because Circle's testnet faucet was under maintenance on 2026-11-23; a first router/vault pair built over Circle's Atlantic USDC is kept in [`deployments/atlantic.json`](deployments/atlantic.json) (`retired`). Wallet: a fresh Atlantic-only test wallet `0xdcA5…7CbE`.

**Run 1, success** (`atlantic-success`): 5 steps, each receipt verified before the next, ends `COMPLETED` with no USDC/WPHRS left behind and no open allowances.

| Step | Transaction |
|---|---|
| 1 wrap 0.05 PHRS | [`0x4e12fee6…`](https://atlantic.pharosscan.xyz/tx/0x4e12fee65ab711da6a8becf03119644e54150b39df97c4576f1303c9d5b6a8ec) |
| 2 approve WPHRS | [`0x61a78634…`](https://atlantic.pharosscan.xyz/tx/0x61a7863421497f3fc55c5836b0cde0f8b86c1f75b300352957c59b8aad136b50) |
| 3 swap → 1.974316 tUSDC | [`0xc028aea3…`](https://atlantic.pharosscan.xyz/tx/0xc028aea3b4f8568d1ad3fa78e59beea8b6352959163fa46e11e7434954029918) |
| 4 approve the vault | [`0x8f2c989e…`](https://atlantic.pharosscan.xyz/tx/0x8f2c989eba29a90006d1044200a407211d77c8f21a9d38a1478b68c4b5a78dab) |
| 5 deposit → 1.974316 stUSDC | [`0x2129b439…`](https://atlantic.pharosscan.xyz/tx/0x2129b439ccf6c7214303ad3cff532f480369c5e0f422df2d11c687b215844188) |

**Run 2, forced failure → rollback** (`atlantic-rollback`, `--fail deposit`): steps 1–4 succeed, the deposit asks for 1 unit more than approved and **reverts on chain**, then the saga undoes everything in reverse order and ends `COMPENSATED` (back to PHRS, no shares, no allowances). The Atlantic RPC also answered HTTP 429 three times during the rollback; the retry policy handled each one.

| Step | Transaction |
|---|---|
| 1 wrap · 2 approve · 3 swap · 4 approve | [`0x27646c12…`](https://atlantic.pharosscan.xyz/tx/0x27646c12658a41e63899af93d335277a38c8f5658faf72e30eac3c5954f19253) · [`0x048ac467…`](https://atlantic.pharosscan.xyz/tx/0x048ac467472d563ab0065904c784b10847d9f5753a41fc95561d7509651280bb) · [`0x88ab4def…`](https://atlantic.pharosscan.xyz/tx/0x88ab4deffa666d1837c7b52dbcaad981a9b6eb0181dbddd40184f56ef37697b3) · [`0x96703485…`](https://atlantic.pharosscan.xyz/tx/0x967034850f9e8897e85914a725d4f5dea336189c86e563d9e564bff29ab232ee) |
| 5 deposit — **reverted** (forced) | [`0xa2cd5d26…`](https://atlantic.pharosscan.xyz/tx/0xa2cd5d26aa3a57e5b4b473125c7dac078f4aeb09f35f15c51dcdf021a7547040) |
| undo: revoke the vault allowance | [`0xec738bf2…`](https://atlantic.pharosscan.xyz/tx/0xec738bf243035ac757e4d68e42943c9b83154b0a2a71c2edafe3f8ee1fadf9f6) |
| undo: approve the pool for the swap back | [`0x4e7ec3d8…`](https://atlantic.pharosscan.xyz/tx/0x4e7ec3d8202c42abe81b96508c6454e09a2d480a2cfba82c60429d15f89d77ef) |
| undo: swap tUSDC back to WPHRS | [`0xd7d38eb1…`](https://atlantic.pharosscan.xyz/tx/0xd7d38eb129309a2ca27418bef18319ca535bfed4854b0857aa7c36b354d9d330) |
| undo: revoke WPHRS allowance | skipped: already 0 (the swap used it exactly) |
| undo: unwrap back to PHRS | [`0x1c03f5f4…`](https://atlantic.pharosscan.xyz/tx/0x1c03f5f4ec198f4491429bae3e1a4298334508e4863a810a887381acfb6f6f00) |

Both runs replay step by step on the demo (`Atlantic: success`, `Atlantic: forced failure → rollback`), and `node scripts/verify-atlantic-txs.mjs runs/local deployments/atlantic.json` re-reads every receipt from the chain.

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | ≥ 3 dependent steps, each verified (receipt checked) before the next | **5** steps: wrap → approve → swap → approve → deposit. Each is simulated (`eth_estimateGas`), signed, broadcast, and its receipt is checked: `status`, the expected events decoded from the logs (WPROS `Deposit`, `Approval`, `Transfer`, the vault's ERC-4626 `Deposit`) and balances/allowances read **at the receipt's block and the block before**. On Pacific the Chain MCP must report the same receipt too. The next step's tx is only signed after `step.verified` (checked by the end-to-end test). |
| 02 | Defined retry policy for transient failures (gas spike, dropped tx…) | [`lib/policy.js`](lib/policy.js): RPC/429/5xx → backoff 1.5/3/6 s, 4 attempts · dropped (no receipt in 45 s, nonce free) → **same nonce**, +20% fees · `nonce too low` → reconcile receipts first · gas spike above the 50 gwei cap → wait without spending an attempt, pause after 2 min · swap below its minimum → re-quote once. |
| 03 | Defined compensation / rollback path when a step permanently fails, and a demo | LIFO undo of every step the saga executed: revoke the vault allowance → approve FaroSwap → swap the saga's USDC back → revoke the WPROS allowance → unwrap. Only the saga's own amounts (balance now − balance at the start). `--compensation park` stops in USDC instead. Demo: `--fail deposit` / `--fail swap` (real on-chain reverts). |
| 04 | State log showing exactly which step the saga is in at any time | Append-only `runs/local/<id>/events.jsonl`; the state is a pure fold of the events ([`lib/log.js`](lib/log.js)). `npm run saga -- status` prints `NOW: RUNNING · step swap · submitted · tx 0x… nonce 25 · attempt 1`; `watch` follows it live; the web page replays it event by event. |
| 05 | One fully successful run and one forced-failure run with recovery | **On chain, on Pharos Atlantic Testnet**: [success](#real-runs-on-pharos-atlantic-testnet) and [forced failure → rollback](#real-runs-on-pharos-atlantic-testnet), every tx linked. Extra scenarios on a local fork of Pacific (swap failure → re-quote → rollback, transient faults → retries, crash → resume) are in [`public/runs/`](public/runs) and on the demo. |

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

On Pharos Atlantic Testnet, for real (a test wallet in `.env` as `PRIVATE_KEY`, holding a little PHRS):

```bash
node scripts/compile-atlantic.mjs && node scripts/deploy-atlantic.mjs   # once: the test contracts + test tUSDC
npm run saga -- run --network atlantic --amount 0.05
npm run saga -- run --network atlantic --amount 0.05 --fail deposit     # forced failure → rollback
npm run saga -- status latest --network atlantic
```

On the real Pacific Mainnet (real funds, your key in `.env`, see `.env.example`):

```bash
npm run saga -- run --network pacific --amount 2 --yes
npm run saga -- run --network pacific --amount 2 --fail deposit --yes
npm run saga -- export latest pacific-forced-failure     # shows it on the demo with explorer links
```

| Option | Default | Meaning |
|---|---|---|
| `--network fork\|atlantic\|pacific` | fork | local Anvil fork of Pacific (test account), Atlantic Testnet (test contracts, real txs) or Pacific Mainnet |
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

## Why a fork for the extra demos

The two required runs are real Atlantic transactions (above). The fork is only used for the extra fault-injection demos and the end-to-end test. The fork is Anvil forking Pacific Mainnet at the latest block: the same bytecode, the same pool liquidity, the same vault state. It lets the demo force gas spikes and crashes and run with a test account. Anvil and not Hardhat because Pacific block headers have no `excessBlobGas` (Hardhat panics) and the Morpho V2 vaults need Cancun opcodes.

## Tests

- `npm test` — 23 unit tests: classification (incl. the Pharos `80004` unfunded-account error), backoff, fee bump, decisions, the reducer (incl. crash replay and settled replacements), the compensation plan, mixSwap calldata.
- `npm run test:fork` — 11 end-to-end cases on a fresh fork: success with ordering check, forced deposit failure, forced swap failure with a real re-quote (two different nonces), park policy, 503 + dropped + gas spike, crash → status → resume with exactly one deposit, a verification error after mining (re-verified, sent exactly once), option validation.
