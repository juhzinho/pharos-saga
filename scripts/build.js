// Copies the pure state-log reducer to public/lib so the web viewer replays runs with the exact same code as the CLI,
// and writes public/runs/index.json from the exported runs.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
mkdirSync(join(root, "public", "lib"), { recursive: true });
copyFileSync(join(root, "lib", "log.js"), join(root, "public", "lib", "log.js"));

const runsDir = join(root, "public", "runs");
mkdirSync(runsDir, { recursive: true });
const ORDER = ["pacific-success", "pacific-forced-failure", "fork-success", "fork-forced-failure", "fork-transient", "fork-crash-resume", "fork-swap-failure"];
const runs = readdirSync(runsDir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => {
    const run = JSON.parse(readFileSync(join(runsDir, f), "utf8"));
    const start = run.events.find((e) => e.event === "saga.start");
    const done = run.events.findLast((e) => e.event === "saga.done");
    return { name: run.name, id: run.id, network: start.network, status: done?.status ?? "unfinished", events: run.events.length, t: start.t };
  })
  .sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99));
writeFileSync(join(runsDir, "index.json"), JSON.stringify(runs, null, 1) + "\n");
console.log(`build: public/lib/log.js + ${runs.length} runs in public/runs/index.json`);
