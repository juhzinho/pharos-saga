// Re-reads every Atlantic tx hash the two projects recorded (saga logs, x402 ledgers, deploy txs) and checks each
// receipt on chain. Usage: node scripts/verify-atlantic-txs.mjs <dir>...
import { createPublicClient, http } from "viem";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const c = createPublicClient({ transport: http("https://atlantic.dplabs-internal.com", { retryCount: 6, retryDelay: 700 }) });
const hashes = new Map();
const add = (h, where) => { if (/^0x[0-9a-f]{64}$/i.test(h)) hashes.set(h.toLowerCase(), where); };
for (const dir of process.argv.slice(2)) {
  if (dir.endsWith(".json")) { const j = JSON.parse(readFileSync(dir, "utf8")); for (const [k, h] of Object.entries(j.txs ?? {})) add(h, `deploy: ${k}`); continue; }
  for (const run of readdirSync(dir)) {
    if (!run.startsWith("atlantic")) continue;
    for (const f of ["events.jsonl", "ledger.jsonl"]) {
      const p = join(dir, run, f);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean)) {
        const e = JSON.parse(line);
        for (const k of ["hash", "tx", "txHash"]) if (e[k]) add(e[k], `${run} · ${e.type ?? e.kind ?? ""} ${e.step ?? e.item ?? ""}`.trim());
      }
    }
  }
}
let ok = 0, bad = 0, missing = 0;
for (const [h, where] of hashes) {
  const r = await c.getTransactionReceipt({ hash: h }).catch(() => null);
  if (!r) { missing++; console.log(`MISSING ${h}  ${where}`); continue; }
  r.status === "success" ? ok++ : bad++;
  console.log(`${r.status === "success" ? "ok      " : "REVERTED"} ${h} block ${r.blockNumber}  ${where}`);
}
console.log(`\n${hashes.size} txs: ${ok} success, ${bad} reverted (expected only for forced failures), ${missing} not found`);
