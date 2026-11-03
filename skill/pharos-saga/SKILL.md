---
name: pharos-saga
description: Run a multi-step, dependent on-chain workflow on Pharos Pacific Mainnet as a saga — wrap PROS, approve, swap on FaroSwap, approve, deposit into a Morpho USDC vault — verifying every receipt before the next step, retrying transient failures safely and compensating (rolling back) when a step fails permanently. Use for "approve → swap → deposit", "put my PROS into a vault", "saga", "rollback", "retry a failed transaction" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
---

# Pharos Saga

A Skill for agents that must move funds through several dependent transactions without ever leaving them stranded halfway.

```
PROS ──wrap──▶ WPROS ──approve──▶ FaroSwap ──swap──▶ USDC ──approve──▶ Morpho vault ──deposit──▶ shares
```

Every step is **simulated, sent, receipt-checked and verified** (events + balances read at the receipt's block) before the next one starts. Transient failures are retried under a fixed policy. A permanent failure triggers **compensation**: the completed steps are undone in reverse order until the wallet is back where it started (or parked in USDC).

## When to use

- The user wants to put PROS (or WPROS) into a USDC yield vault on Pharos in one go.
- Any approve → swap → deposit style flow where a half-finished run would leave tokens or approvals behind.
- The user asks what state a running workflow is in, or wants to resume one after a crash.

## Contracts (Pacific Mainnet, chain 1672)

| Role | Address |
|---|---|
| WPROS (official registry) | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` |
| USDC (official registry) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` |
| FaroSwap DODORouteProxy | `0xA5cA5Fbe34e444F366B373170541ec6902b0F75c` |
| FaroSwap approval target (DODOApprove) | `0xBF105f4ffBD3825f5433d074008B9A76237d849c` |
| FaroSwap WPROS/USDC 0.01% pool | `0x912c9aDe24D44d8922f0866D8Dcb079f1363f647` |
| Morpho RockawayX USDC vault | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` |
| Morpho SharpByte USDC vault | `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` |

Details and how each address was confirmed: [references/contracts.md](references/contracts.md).

## How to run it

The executable lives in the repository root (`tasks/saga/saga.js`). From there:

```bash
npm install
npm run saga -- plan --amount 2                 # live Pacific quote, no key needed — always show this first
npm run saga -- run --amount 2                  # on a local Anvil fork of Pacific (test account, no real funds)
npm run saga -- run --network pacific --amount 2 --yes   # real funds; PRIVATE_KEY in .env
npm run saga -- status latest                   # which step it is in right now
npm run saga -- resume latest                   # after a crash, a pause (gas spike) or Ctrl+C
```

Foundry users can get the same five steps as `cast send` commands:

```bash
npm run saga -- cast --from 0xYourAddress --amount 2
```

## Rules for the agent

1. **Always show the plan first** (`plan`) and say which network it will run on. On `pacific`, real funds move: get an explicit yes from the user, then pass `--yes`.
2. **Never ask for, print or log a private key.** The key is read from `PRIVATE_KEY` in `.env` by the script itself; only signed transactions leave the machine.
3. **One step at a time.** Do not start a step until the previous one is `VERIFIED`. The script enforces this; do not bypass it by sending raw transactions yourself.
4. **Report from the state log, not from memory.** `status` prints the current step, its attempt and its last tx hash.
5. If the saga ends `STUCK`, stop and show the user the failing step and its message. Do not improvise transactions.

## Retry policy (transient failures)

| Failure | What happens |
|---|---|
| RPC error, timeout, 429 / 5xx | back off 1.5 s, 3 s, 6 s (max 4 attempts per step) |
| tx not mined in 45 s, nonce still free (dropped) | re-broadcast with the **same nonce** and +20% fees — only one of them can ever be mined |
| "nonce too low" / "already known" | re-read the chain: the tx may already be in |
| base fee above the 50 gwei cap (gas spike) | wait, without using an attempt; after 2 min the saga **pauses** (safe, resumable) |
| swap returned less than its minimum | re-quote once, then treat as permanent |

Full table and the reasoning: [references/retry-policy.md](references/retry-policy.md).

## Compensation (permanent failures)

| Failed at | Undo, in this order |
|---|---|
| deposit | revoke vault allowance → approve FaroSwap → swap the saga's USDC back → revoke WPROS allowance → unwrap |
| approve-usdc | swap back → revoke → unwrap |
| swap | revoke WPROS allowance → unwrap |
| approve-wpros | unwrap |

Only what **this saga** created is undone (amounts are computed as "balance now − balance before the saga"); approvals the user already had are left alone. With `--compensation park` the saga stops in USDC instead of swapping back. See [references/compensation.md](references/compensation.md).

## State log

Every transition is appended to `runs/local/<id>/events.jsonl` before the next action. The current state is a pure fold of those events, so after a crash `resume` knows exactly which transaction hashes were already broadcast and checks their receipts instead of sending again. See [references/state-log.md](references/state-log.md).
