#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAddress, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ABI, FAROSWAP, TOKENS, VAULTS } from "../../lib/contracts.js";
import { localSigner, NETWORKS, publicClientFor, readFees } from "../../lib/chain.js";
import { DEFAULT_POLICY } from "../../lib/policy.js";
import { Injector, runSaga } from "../../lib/engine.js";
import { StateLog, replay } from "../../lib/log.js";
import { fileSink, loadEvents, newSagaId, resolveId, RUNS_DIR } from "../../lib/store.js";
import { renderEvent, renderStatus } from "../../lib/render.js";
import { encodeMixSwap, minAfterSlippage, previewDeposit, quoteProsToUsdc } from "../../lib/quote.js";
import { FAIL_POINTS, FORWARD, fmt } from "../../lib/steps.js";
import { FORK_TEST_KEY, startFork } from "../../lib/fork.js";
import { chainMcpVerifier } from "../../lib/mcp.js";

const HELP = `pharos-saga — a receipt-verified multi-step saga on Pharos Pacific, with retry and compensation

  PROS → wrap → approve → FaroSwap swap → approve → Morpho vault deposit

Usage:
  npm run saga -- run [options]        run a new saga (default: on a local fork of Pacific Mainnet)
  npm run saga -- status [id]          which step the saga is in right now (default: latest)
  npm run saga -- watch [id]           follow the state log live
  npm run saga -- resume [id]          continue a paused or crashed saga from its log
  npm run saga -- plan [--amount n]    live quote on Pacific Mainnet: what the saga would do right now (no key)
  npm run saga -- cast --from 0x…      the same five steps as Foundry cast commands (SkillEngine)
  npm run saga -- export <id> <name>   copy a run to public/runs/<name>.json for the web viewer

Run options:
  --network fork|pacific   fork (default) starts Anvil and uses a test account; pacific uses PRIVATE_KEY from .env
  --amount <PROS>          amount to put through the saga (default 2)
  --vault rock|sharp       RockawayX (default) or SharpByte USDC vault on Morpho
  --compensation unwind|park   on permanent failure: unwind back to PROS (default) or park in USDC
  --fail swap|deposit      force a permanent on-chain failure at that step (demo of compensation)
  --inject <kind@step>     inject a fault: rpc@<step>, drop@<step>, gas@<step> (fork), crash@<step>, verify@<step>
  --receipt-timeout <s>    seconds before an unmined tx counts as dropped (default ${DEFAULT_POLICY.receiptTimeoutMs / 1000})
  --max-fee <gwei>         gas price cap (default ${DEFAULT_POLICY.maxFeeGwei})
  --slippage <bps>         swap minimum-return guard (default ${DEFAULT_POLICY.slippageBps} = 1%)
  --max-amount <PROS>      safety cap on Pacific (default 20)
  --yes                    required on Pacific: you confirm real funds will move
  --id <id>                saga id (default: generated)

Steps: ${FORWARD.join(", ")}
`;

function parse(argv) {
  const o = { cmd: argv[0] && !argv[0].startsWith("--") ? argv[0] : "run", rest: [], inject: [] };
  const args = o.cmd === argv[0] ? argv.slice(1) : argv;
  const need = (i, name) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
      case "-h":
        o.help = true;
        break;
      case "--yes":
        o.yes = true;
        break;
      case "--network": o.network = need(i, a); i++; break;
      case "--amount": o.amount = need(i, a); i++; break;
      case "--vault": o.vault = need(i, a); i++; break;
      case "--compensation": o.compensation = need(i, a); i++; break;
      case "--fail": o.fail = need(i, a); i++; break;
      case "--inject": o.inject.push(need(i, a)); i++; break;
      case "--receipt-timeout": o.receiptTimeout = need(i, a); i++; break;
      case "--max-fee": o.maxFee = need(i, a); i++; break;
      case "--slippage": o.slippage = need(i, a); i++; break;
      case "--max-amount": o.maxAmount = need(i, a); i++; break;
      case "--id": o.id = need(i, a); i++; break;
      case "--from": o.from = need(i, a); i++; break;
      default:
        if (a.startsWith("--")) fail(`Unknown option: ${a}`);
        o.rest.push(a);
    }
  }
  return o;
}

function fail(msg, code = 1) {
  console.error(`${msg}\n\n${HELP}`);
  process.exit(code);
}

function positiveNumber(v, name, { max } = {}) {
  if (!/^\d+(\.\d+)?$/.test(String(v)) || Number(v) <= 0) fail(`${name} must be a positive number (got "${v}")`);
  if (max != null && Number(v) > max) fail(`${name} must be at most ${max}`);
  return v;
}

// 0.01 PROS minimum: below it the swap output rounds to a few micro-USDC and the run proves nothing.
function amountArg() {
  const v = positiveNumber(o.amount ?? "2", "--amount");
  if (Number(v) < 0.01) fail("--amount must be at least 0.01 PROS");
  if (!/^\d+(\.\d{1,18})?$/.test(String(v))) fail("--amount has more than 18 decimals");
  return v;
}

function readEnvKey() {
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  if (existsSync(".env")) {
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => /^\s*PRIVATE_KEY\s*=/.test(l));
    if (line) return line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const o = parse(process.argv.slice(2));
if (o.help) {
  console.log(HELP);
  process.exit(0);
}

function policyFrom(opts) {
  return {
    ...DEFAULT_POLICY,
    ...(opts.receiptTimeout ? { receiptTimeoutMs: Number(positiveNumber(opts.receiptTimeout, "--receipt-timeout")) * 1000 } : {}),
    ...(opts.maxFee ? { maxFeeGwei: Number(positiveNumber(opts.maxFee, "--max-fee")) } : {}),
    ...(opts.slippage ? { slippageBps: Number(positiveNumber(opts.slippage, "--slippage", { max: 1000 })) } : {}),
  };
}

async function mainnetQuote(amountPros, vault) {
  const client = publicClientFor(NETWORKS.pacific);
  const amount = parseEther(String(amountPros));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
  const [usdc, fees, block] = await Promise.all([quoteProsToUsdc(client, amount, deadline), readFees(client), client.getBlockNumber()]);
  const shares = await previewDeposit(client, vault.address, usdc);
  return { client, amount, usdc, shares, fees, block, deadline };
}

// Gas measured on a fork of Pacific (block 22,035,806); the saga re-estimates every step before sending.
const MEASURED_GAS = { wrap: 27_842n, "approve-wpros": 46_111n, swap: 194_937n, "approve-usdc": 55_437n, deposit: 315_387n };

async function cmdPlan() {
  const amountPros = amountArg();
  const vault = VAULTS[o.vault ?? "rock"] ?? fail(`--vault must be rock or sharp`);
  const policy = policyFrom(o);
  const q = await mainnetQuote(amountPros, vault);
  const min = minAfterSlippage(q.usdc, policy.slippageBps);
  const gas = Object.values(MEASURED_GAS).reduce((a, b) => a + b, 0n);
  console.log(`PLAN on Pharos Pacific Mainnet · block ${q.block.toLocaleString("en-US")} · base fee ${(Number(q.fees.baseFee) / 1e9).toFixed(2)} gwei\n`);
  console.log(`  1 wrap           ${fmt.pros(q.amount)} → ${fmt.wpros(q.amount)}`);
  console.log(`  2 approve-wpros  DODOApprove ${FAROSWAP.dodoApprove} for ${fmt.wpros(q.amount)}`);
  console.log(`  3 swap           FaroSwap 0.01% pool → ${fmt.usdc(q.usdc)} now (minimum ${fmt.usdc(min)} at ${policy.slippageBps / 100}% slippage)`);
  console.log(`  4 approve-usdc   ${vault.name} for the USDC received`);
  console.log(`  5 deposit        → ${fmt.shares(q.shares, vault.symbol)} (previewDeposit now)`);
  console.log(`\n  price now: 1 PROS = ${fmt.usdc((q.usdc * 10n ** 18n) / q.amount)}`);
  console.log(`  gas: ~${gas.toLocaleString("en-US")} units ≈ ${fmt.pros(gas * q.fees.baseFee)} at the current base fee`);
  console.log(`\nAll numbers read live from Pacific (swap quoted by simulating the real mixSwap; shares by the vault's previewDeposit).`);
}

async function cmdCast() {
  if (!o.from || !isAddress(o.from)) fail("cast needs --from 0x… (the wallet that will sign; it receives the vault shares)");
  const from = getAddress(o.from);
  const amountPros = amountArg();
  const vault = VAULTS[o.vault ?? "rock"] ?? fail(`--vault must be rock or sharp`);
  const policy = policyFrom(o);
  const q = await mainnetQuote(amountPros, vault);
  const min = minAfterSlippage(q.usdc, policy.slippageBps);
  const rpc = "--rpc-url https://rpc.pharos.xyz --private-key $PRIVATE_KEY";
  const swapData = encodeMixSwap({ fromToken: TOKENS.WPROS.address, toToken: TOKENS.USDC.address, amount: q.amount, expReturn: q.usdc, minReturn: min, direction: 0, deadline: q.deadline });
  console.log(`# Saga as Foundry cast commands (SkillEngine). Quoted at Pacific block ${q.block}; the swap deadline is 20 minutes.`);
  console.log(`# Run them in order and check each receipt (cast receipt <hash>) before the next one — or let "npm run saga" do it.\n`);
  console.log(`# 1 wrap\ncast send ${TOKENS.WPROS.address} "deposit()" --value ${q.amount} ${rpc}\n`);
  console.log(`# 2 approve WPROS for FaroSwap\ncast send ${TOKENS.WPROS.address} "approve(address,uint256)" ${FAROSWAP.dodoApprove} ${q.amount} ${rpc}\n`);
  console.log(`# 3 swap on FaroSwap (min ${fmt.usdc(min)})\ncast send ${FAROSWAP.routeProxy} ${swapData} ${rpc}\n`);
  console.log(`# 4 approve USDC for the vault (use the exact USDC received in step 3; ${q.usdc} if the quote holds)\ncast send ${TOKENS.USDC.address} "approve(address,uint256)" ${vault.address} ${q.usdc} ${rpc}\n`);
  console.log(`# 5 deposit into ${vault.name}\ncast send ${vault.address} "deposit(uint256,address)" ${q.usdc} ${from} ${rpc}`);
}

function cmdStatus() {
  const id = resolveId(o.rest[0]);
  const state = replay(loadEvents(id));
  console.log(renderStatus(state, { explorer: state.network === "pacific" }));
}

async function cmdWatch() {
  const id = resolveId(o.rest[0]);
  let shown = 0;
  console.log(`watching ${id} (Ctrl+C to stop)\n`);
  for (;;) {
    const events = loadEvents(id);
    for (; shown < events.length; shown++) {
      const state = replay(events.slice(0, shown + 1));
      for (const line of renderEvent(events[shown], state, { explorer: state.network === "pacific" })) console.log(line);
    }
    const st = replay(events).status;
    if (["completed", "compensated", "stuck"].includes(st)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function cmdExport() {
  const [idArg, name] = o.rest;
  if (!name || !/^[a-z0-9-]+$/.test(name)) fail("export needs <id> <name> (name: lowercase letters, digits, dashes)");
  const id = resolveId(idArg);
  const events = loadEvents(id).map(({ raw, ...e }) => e); // signed raw txs stay local
  const dir = join(process.cwd(), "public", "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, id, events }, null, 1) + "\n");
  console.log(`wrote public/runs/${name}.json (${events.length} events)`);
}

async function setup(opts, existing) {
  const network = NETWORKS[existing?.network ?? opts.network ?? "fork"] ?? fail("--network must be fork or pacific");
  let fork = null;
  if (network.id === "fork") {
    fork = await startFork({ port: Number(new URL(network.rpc).port || 8545), detached: true });
    if (!fork.reused) console.log(`started an Anvil fork of Pharos Pacific Mainnet at ${fork.url} (left running so the saga can be resumed; stop it when done)
`);
  }
  const key = network.id === "fork" ? readEnvKey() ?? FORK_TEST_KEY : readEnvKey();
  if (!key) fail("Pacific needs PRIVATE_KEY in .env (see .env.example). The key never leaves this machine; only signed transactions are broadcast.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail("PRIVATE_KEY must be 0x followed by 64 hex characters");
  const account = privateKeyToAccount(key);
  const client = publicClientFor(network);
  const chainId = await client.getChainId();
  if (chainId !== 1672) fail(`${network.rpc} reports chain ${chainId}, expected Pharos Pacific (1672)`);
  return { network, fork, client, signer: localSigner(account, client) };
}

function printer(network) {
  return (entry, state) => {
    for (const line of renderEvent(entry, state, { explorer: network.id === "pacific" })) console.log(line);
  };
}

async function cmdRun() {
  const amountPros = amountArg();
  const vault = VAULTS[o.vault ?? "rock"] ?? fail("--vault must be rock or sharp");
  const compensation = o.compensation ?? "unwind";
  if (!["unwind", "park"].includes(compensation)) fail("--compensation must be unwind or park");
  if (o.fail && !FAIL_POINTS.includes(o.fail)) fail(`--fail must be ${FAIL_POINTS.join(" or ")}`);
  const inject = new Injector(Injector.parse(o.inject));
  for (const r of inject.rules) if (!FORWARD.includes(r.step) && !["revoke-usdc", "approve-usdc-back", "swap-back", "revoke-wpros", "unwrap"].includes(r.step)) fail(`--inject: unknown step "${r.step}"`);
  const policy = policyFrom(o);
  const { network, fork, client, signer } = await setup(o);
  if (network.id === "pacific") {
    const cap = Number(o.maxAmount ?? 20);
    if (Number(amountPros) > cap) fail(`--amount ${amountPros} is above the Pacific safety cap of ${cap} PROS (raise it with --max-amount)`);
    if (inject.rules.some((r) => r.kind === "gas")) fail("gas@ injection only works on the fork");
    if (!o.yes) fail(`This moves real funds on Pharos Pacific Mainnet from ${signer.address}. Re-run with --yes to confirm.`);
  }
  const amount = parseEther(String(amountPros));
  const balance = await client.getBalance({ address: signer.address });
  const reserve = parseEther("0.05");
  if (balance < amount + reserve) fail(`${signer.address} has ${fmt.pros(balance)}; the saga needs ${fmt.pros(amount)} plus ~0.05 PROS for gas`);
  const asset = await client.readContract({ address: vault.address, abi: ABI.vault, functionName: "asset" });
  if (getAddress(asset) !== TOKENS.USDC.address) fail(`${vault.name} asset is ${asset}, not USDC`);

  const id = o.id ?? newSagaId();
  const log = new StateLog({ sagaId: id, sink: fileSink(id), onChange: printer(network) });
  const mcp = network.id === "pacific" ? await chainMcpVerifier().catch(() => null) : null;
  const state = await runSaga({ client, signer, log, network, policy, inject, mcp, params: { amount: amount.toString(), vault, compensation, fail: o.fail ?? null } });
  await mcp?.close();
  console.log(`\nstate log: ${join(RUNS_DIR, id, "events.jsonl")}\nstatus:    npm run saga -- status ${id}`);
  process.exit(state.status === "completed" || state.status === "compensated" ? 0 : 2);
}

async function cmdResume() {
  const id = resolveId(o.rest[0]);
  const events = loadEvents(id);
  const prev = replay(events);
  if (["completed", "compensated"].includes(prev.status)) {
    console.log(`${id} already finished: ${prev.status}`);
    process.exit(0);
  }
  const { network, fork, client, signer } = await setup(o, prev);
  if (signer.address !== prev.account) fail(`${id} belongs to ${prev.account}; the configured key is ${signer.address}`);
  const vault = Object.values(VAULTS).find((v) => v.address === prev.params.vault.address);
  const policy = { ...policyFrom(o), slippageBps: prev.params.slippageBps, maxFeeGwei: o.maxFee ? Number(o.maxFee) : prev.params.maxFeeGwei };
  const log = new StateLog({ sagaId: id, events, sink: fileSink(id), onChange: printer(network) });
  console.log(renderStatus(prev, { explorer: network.id === "pacific" }) + "\n");
  const mcp = network.id === "pacific" ? await chainMcpVerifier().catch(() => null) : null;
  const state = await runSaga({ client, signer, log, network, policy, inject: new Injector(Injector.parse(o.inject)), mcp, params: { amount: prev.params.amount, vault, compensation: prev.params.compensation, fail: prev.params.fail } });
  await mcp?.close();
  process.exit(state.status === "completed" || state.status === "compensated" ? 0 : 2);
}

const commands = { run: cmdRun, status: cmdStatus, watch: cmdWatch, resume: cmdResume, plan: cmdPlan, cast: cmdCast, export: cmdExport };
const fn = commands[o.cmd] ?? (() => fail(`Unknown command: ${o.cmd}`));
try {
  await fn();
  if (["plan", "cast", "status", "export", "watch"].includes(o.cmd)) process.exit(0);
} catch (e) {
  console.error(`error: ${e.shortMessage ?? e.message}`);
  if (process.env.SAGA_DEBUG) console.error(e.stack);
  process.exit(1);
}
