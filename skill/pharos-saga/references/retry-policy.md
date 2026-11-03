# Retry policy

Code: `lib/policy.js` (pure functions, unit-tested in `test/policy.test.js`).

| Setting | Default | Flag |
|---|---|---|
| attempts per step (first try included) | 4 | — |
| backoff | 1.5 s, 3 s, 6 s … capped at 15 s, +0–20% jitter | — |
| receipt timeout (then "dropped") | 45 s | `--receipt-timeout` |
| replacement fee bump | +20% on max fee and tip | — |
| fee cap | 50 gwei | `--max-fee` |
| gas-spike wait before pausing | 120 s | — |
| swap slippage guard | 1% | `--slippage` |
| re-quotes after a slippage revert | 1 | — |

## Classification

| Kind | Example message | Transient? | Action |
|---|---|---|---|
| `rpc` | fetch failed, 429, 503, timeout | yes | back off and retry the step |
| `dropped` | no receipt after the timeout, nonce still free | yes | same nonce, +20% fees (replacement) |
| `nonce` | nonce too low, already known | yes | reconcile: look for the receipt of every hash sent for that nonce |
| `underpriced` | replacement transaction underpriced | yes | bump and resend with the same nonce |
| gas spike | base fee > cap | — | wait; does not use an attempt; pause after 2 min |
| `slippage` | Return amount is not enough | yes, once | re-quote, rebuild, resend |
| `revert` | execution reverted, custom error | no | compensate |
| `verify` | receipt ok but events/balances wrong | no | compensate |
| `exhausted` | a transient error after 4 attempts | no | compensate |
| `nonce-taken` | the nonce was used by a tx this saga never sent | no | stop (compensating would guess) |

## Why the same payment / swap can never happen twice

1. The tx is **signed locally first**; its hash is written to the state log **before** it is broadcast.
2. Before any new attempt, the engine **reconciles**: it asks for the receipt of every hash it already sent for that step. If one is mined, it is used — nothing new is sent.
3. A replacement always reuses the **same nonce**, so the chain accepts at most one of them.
4. Every step also has an idempotency **precheck** (an approval that already exists is skipped).
