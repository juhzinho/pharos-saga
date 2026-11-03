#!/usr/bin/env node
// npm run fork [-- --port 8545 --block <n>]  — a local Anvil fork of Pharos Pacific Mainnet for the saga demos.
import { startFork } from "../lib/fork.js";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(opt("--port") ?? 8545);
const fork = await startFork({ port, block: opt("--block"), quiet: true });
console.log(`${fork.reused ? "Already running" : "Started"}: Anvil fork of Pharos Pacific Mainnet at ${fork.url} (chain 1672)`);
if (fork.reused) process.exit(0);
console.log("Press Ctrl+C to stop.");
process.on("SIGINT", () => {
  fork.stop();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
