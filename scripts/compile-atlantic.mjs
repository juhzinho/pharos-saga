// Compiles contracts/atlantic/SagaTest.sol with solc 0.8.24 (OpenZeppelin 5.1 from node_modules) into
// contracts/atlantic/build.json: { name: { abi, bytecode } }.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const solc = createRequire(import.meta.url)("solc");
const src = "contracts/atlantic/SagaTest.sol";
const input = { language: "Solidity", sources: { [src]: { content: readFileSync(src, "utf8") } }, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const find = (p) => { try { return { contents: readFileSync(p.startsWith("@") ? `node_modules/${p}` : p, "utf8") }; } catch { return { error: `not found: ${p}` }; } };
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: find }));
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const build = {};
for (const [name, c] of Object.entries(out.contracts[src])) build[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
writeFileSync("contracts/atlantic/build.json", JSON.stringify(build));
console.log("compiled:", Object.keys(build).map((n) => `${n} (${(build[n].bytecode.length - 2) / 2} bytes)`).join(", "));
