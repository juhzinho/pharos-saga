// End-to-end: a fresh Anvil fork of Pharos Pacific Mainnet, the real CLI, every scenario the task asks for.
// npm run test:fork        (needs network access to https://rpc.pharos.xyz; ~2–4 minutes)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFork } from "../lib/fork.js";

const PORT = 8547;
const fork = await startFork({ port: PORT });
const RUNS = mkdtempSync(join(tmpdir(), "saga-e2e-"));
const env = { ...process.env, FORK_RPC_URL: `http://127.0.0.1:${PORT}`, SAGA_RUNS_DIR: RUNS, PRIVATE_KEY: "" };
delete env.PRIVATE_KEY;

function run(args, { timeout = 240_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["tasks/saga/saga.js", ...args], { cwd: new URL("..", import.meta.url), env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const events = (id) => readFileSync(join(RUNS, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const CASES = [
  {
    name: "success: 5 dependent steps, each verified before the next",
    args: ["run", "--amount", "2", "--id", "e2e-ok"],
    code: 0,
    expect: [/step 1\/5 wrap[\s\S]*VERIFIED[\s\S]*step 2\/5 approve-wpros[\s\S]*VERIFIED[\s\S]*step 3\/5 swap[\s\S]*VERIFIED[\s\S]*step 4\/5 approve-usdc[\s\S]*VERIFIED[\s\S]*step 5\/5 deposit[\s\S]*VERIFIED[\s\S]*COMPLETED/, /✓ no open allowances/],
    reject: [/✗/],
    after: (id) => {
      const ev = events(id);
      // every tx.sent of step N+1 comes after step N's step.verified
      const order = ["wrap", "approve-wpros", "swap", "approve-usdc", "deposit"];
      for (let i = 1; i < order.length; i++) {
        const verified = ev.findIndex((e) => e.event === "step.verified" && e.step === order[i - 1]);
        const sent = ev.findIndex((e) => e.event === "tx.sent" && e.step === order[i]);
        if (!(verified >= 0 && sent > verified)) return `${order[i]} was sent before ${order[i - 1]} was verified`;
      }
      return null;
    },
  },
  {
    name: "forced failure at deposit: mined revert, receipt caught, full unwind",
    args: ["run", "--amount", "2", "--fail", "deposit", "--id", "e2e-fail-deposit"],
    code: 0,
    expect: [/receipt · block [\d,]+ · reverted/, /TransferFromReverted\(\)/, /COMPENSATE: deposit failed permanently[\s\S]*revoke-usdc → approve-usdc-back → swap-back → revoke-wpros → unwrap/, /COMPENSATED \(rolled back cleanly\)[\s\S]*✓ back to PROS: WPROS as at start[\s\S]*✓ back to PROS: USDC as at start[\s\S]*✓ no vault shares created[\s\S]*✓ no open allowances/],
  },
  {
    name: "forced failure at swap: re-quoted once (new tx), then unwind",
    args: ["run", "--amount", "2", "--fail", "swap", "--id", "e2e-fail-swap"],
    code: 0,
    expect: [/Return amount is not enough[\s\S]*re-quoting once[\s\S]*step 3\/5 swap · attempt 2/, /COMPENSATED/],
    after: (id) => {
      const swaps = events(id).filter((e) => e.event === "tx.sent" && e.step === "swap");
      return new Set(swaps.map((s) => s.nonce)).size === 2 ? null : `expected 2 swap txs with different nonces, got ${swaps.length}`;
    },
  },
  {
    name: "park policy: keeps USDC, revokes approvals",
    args: ["run", "--amount", "2", "--fail", "deposit", "--compensation", "park", "--id", "e2e-park"],
    code: 0,
    expect: [/revoke-usdc → revoke-wpros → unwrap/, /✓ parked in USDC, nothing else stranded/, /✓ no open allowances/],
    reject: [/swap-back/],
  },
  {
    name: "transient faults: 503, dropped tx replaced with the same nonce, gas spike waited out",
    args: ["run", "--amount", "2", "--inject", "rpc@approve-wpros", "--inject", "drop@swap", "--inject", "gas@approve-usdc", "--receipt-timeout", "5", "--id", "e2e-transient"],
    code: 0,
    expect: [/injected rpc[\s\S]*retry policy: attempt 2/, /injected drop[\s\S]*replaces 0x[0-9a-f]{8}… \(same nonce\)/, /gas spike: base fee 200 gwei > cap 50 gwei/, /COMPLETED/],
    after: (id) => {
      const swap = events(id).filter((e) => e.event === "tx.sent" && e.step === "swap");
      return swap.length === 2 && swap[0].nonce === swap[1].nonce ? null : "the dropped swap was not replaced with the same nonce";
    },
  },
  {
    name: "crash after broadcast → status shows the step → resume does not resend",
    args: ["run", "--amount", "2", "--inject", "crash@deposit", "--id", "e2e-crash"],
    code: 137,
    expect: [/injected crash/],
    then: async () => {
      const st = await run(["status", "e2e-crash"]);
      if (!/NOW: RUNNING · step deposit · submitted · tx 0x/.test(st.out)) return `status did not show the submitted deposit:\n${st.out}`;
      const r = await run(["resume", "e2e-crash"]);
      if (r.code !== 0 || !/already mined; using its receipt instead of sending again[\s\S]*COMPLETED/.test(r.out)) return `resume failed:\n${r.out.slice(-1500)}`;
      const deposits = events("e2e-crash").filter((e) => e.event === "tx.sent" && e.step === "deposit");
      return deposits.length === 1 ? null : `deposit was sent ${deposits.length} times`;
    },
  },
  {
    name: "verification fails after the tx is mined → retry re-verifies, never resends",
    args: ["run", "--amount", "2", "--inject", "verify@swap", "--id", "e2e-verify"],
    code: 0,
    expect: [/injected verify[\s\S]*retry policy: attempt 2[\s\S]*already mined successfully; verifying that receipt again[\s\S]*COMPLETED/],
    after: (id) => {
      const swaps = events(id).filter((e) => e.event === "tx.sent" && e.step === "swap");
      return swaps.length === 1 ? null : `swap was sent ${swaps.length} times`;
    },
  },
  { name: "validation: bad --fail", args: ["run", "--fail", "approve"], code: 1, expect: [/--fail must be swap or deposit/] },
  { name: "validation: bad --inject", args: ["run", "--inject", "boom@swap"], code: 1, expect: [/--inject must look like/] },
  { name: "validation: Pacific needs a key", args: ["run", "--network", "pacific"], code: 1, expect: [/Pacific needs PRIVATE_KEY/] },
  { name: "help", args: ["--help"], code: 0, expect: [/wrap → approve → FaroSwap swap → approve → Morpho vault deposit/] },
];

let failed = 0;
const only = process.argv[2];
for (const c of CASES.filter((c) => !only || c.name.startsWith(only))) {
  const t0 = Date.now();
  const r = await run(c.args);
  let problem = null;
  if (c.code !== undefined && r.code !== c.code) problem = `exit ${r.code}, expected ${c.code}`;
  for (const re of c.expect ?? []) if (!problem && !re.test(r.out)) problem = `missing ${re}`;
  for (const re of c.reject ?? []) if (!problem && re.test(r.out)) problem = `unexpected ${re}`;
  const id = c.args[c.args.indexOf("--id") + 1];
  if (!problem && c.after) problem = c.after(id);
  if (!problem && c.then) problem = await c.then();
  console.log(`${problem ? "FAIL" : "PASS"}  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${c.name}`);
  if (problem) {
    failed++;
    console.log(`      ${problem}\n${r.out.split("\n").slice(-25).map((l) => "      | " + l).join("\n")}`);
  }
}
fork.stop();
console.log(`\n${failed ? `${failed} failed` : "all passed"} · runs in ${RUNS}`);
process.exit(failed ? 1 : 0);
