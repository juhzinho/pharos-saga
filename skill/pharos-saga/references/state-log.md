# State log

File: `runs/local/<saga id>/events.jsonl`, one JSON event per line, written with a synchronous append before the next action.

| Event | Meaning |
|---|---|
| `saga.start` | network, account, parameters, plan, balances at the start |
| `step.start` | a step (or compensation) begins attempt N |
| `step.prepared` | the exact amount a compensation will move ("only what this saga created") |
| `step.skip` | the step's effect is already on chain (idempotency) |
| `step.simulated` | gas estimate, or "simulation predicts a revert" on a forced failure |
| `gas.wait` | base fee above the cap; waiting |
| `tx.sent` | hash, nonce and fees of a signed tx (logged before broadcast) |
| `inject` | a fault injected on purpose (demo/test only) |
| `tx.dropped` | no receipt and the nonce is free |
| `step.reconciled` | a tx from an earlier attempt or before a crash was already mined |
| `receipt` | block, gas, status |
| `mcp.check` | Pacific only: the Chain MCP reports the same receipt |
| `step.verified` | every check passed; facts (e.g. USDC received) |
| `step.failed` / `step.retry` / `step.requote` | what the retry policy decided |
| `saga.compensating` | the permanent failure and the undo plan |
| `saga.paused` / `saga.resume` | gas spike pause, resume |
| `saga.done` | completed / compensated / stuck, with final balances, gas and invariants |

`lib/log.js` folds the events into the current state (`replay(events)`), so `status`, `watch`, `resume` and the web viewer all read the same truth.
