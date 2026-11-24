// Deploys the saga's test contracts on Pharos Atlantic Testnet (FaroSwap and Morpho are not there), seeds the test
// pool, and writes deployments/atlantic.json. Key: PRIVATE_KEY in .env (a test wallet; never printed).
//   node scripts/compile-atlantic.mjs && node scripts/deploy-atlantic.mjs
// The stablecoin is SagaTestUSDC (EIP-3009, like Circle USDC): Circle's testnet faucet was under maintenance on
// 2026-11-23. The first router/vault pair, built over Circle USDC before that, is kept in "retired" for the record.
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const RPC = "https://atlantic.dplabs-internal.com";
const SEED_PHRS = parseEther(process.env.SEED_PHRS ?? "5");
const SEED_USDC = BigInt(Math.round(Number(process.env.SEED_USDC ?? "200") * 1e6));
const MINT_DEPLOYER = 1_000n * 10n ** 6n;
// the x402 buyer's test wallet (pharos-x402-buyer): it pays the x402 sellers in tUSDC
const X402_BUYER = "0x3e085EC0af2E503c5375F436768EFB45c0690b2C";
const MINT_BUYER = 5n * 10n ** 6n;

const key = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => /^\s*PRIVATE_KEY\s*=/.test(l))?.split("=")[1].trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error("PRIVATE_KEY missing in .env");
const account = privateKeyToAccount(key);
const chain = defineChain({ id: 688689, name: "Pharos Atlantic Testnet", nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000 }) });
if ((await client.getChainId()) !== 688689) throw new Error("not Atlantic");
const build = JSON.parse(readFileSync("contracts/atlantic/build.json", "utf8"));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function mint(address,uint256)"]);
const routerAbi = parseAbi(["function withdrawLiquidity(address token, uint256 amount, address to)"]);

const out = existsSync("deployments/atlantic.json") ? JSON.parse(readFileSync("deployments/atlantic.json", "utf8")) : { network: "Pharos Atlantic Testnet", chainId: 688689, deployer: account.address, txs: {} };
const save = () => { mkdirSync("deployments", { recursive: true }); writeFileSync("deployments/atlantic.json", JSON.stringify(out, null, 1) + "\n"); };
const bal = (token, who) => client.readContract({ address: token, abi: erc20, functionName: "balanceOf", args: [who] });
const wait = async (label, hash) => {
  const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  out.txs[label] = hash;
  save();
  console.log(`  ${label}: ${hash} (block ${r.blockNumber})`);
  return r;
};
async function deploy(name, args) {
  if (out[name]) return console.log(`  ${name} already at ${out[name]}`), out[name];
  const r = await wait(`deploy ${name}`, await wallet.deployContract({ abi: build[name].abi, bytecode: build[name].bytecode, args }));
  out[name] = r.contractAddress;
  save();
  return r.contractAddress;
}
console.log(`deployer ${account.address}: ${formatEther(await client.getBalance({ address: account.address }))} PHRS`);

// 1. the test stablecoin, and test balances for the saga wallet and the x402 buyer
const usdc = await deploy("SagaTestUSDC", []);
if ((await bal(usdc, account.address)) === 0n) await wait("mint tUSDC → deployer", await wallet.writeContract({ address: usdc, abi: erc20, functionName: "mint", args: [account.address, MINT_DEPLOYER] }));
if ((await bal(usdc, X402_BUYER)) === 0n) await wait("mint tUSDC → x402 buyer", await wallet.writeContract({ address: usdc, abi: erc20, functionName: "mint", args: [X402_BUYER, MINT_BUYER] }));

// 2. a router/vault built over another stablecoin is retired (its test WPHRS comes back to the deployer)
if (out.usdc && out.usdc.toLowerCase() !== usdc.toLowerCase() && out.SagaTestRouter) {
  const left = await bal(out.SagaWPHRS, out.SagaTestRouter);
  if (left > 0n) await wait("retire: WPHRS back from the old pool", await wallet.writeContract({ address: out.SagaTestRouter, abi: routerAbi, functionName: "withdrawLiquidity", args: [out.SagaWPHRS, left, account.address] }));
  out.retired = { usdc: out.usdc, SagaTestRouter: out.SagaTestRouter, SagaTestVault: out.SagaTestVault, why: "built over Circle USDC; Circle's testnet faucet was under maintenance, so the saga uses SagaTestUSDC" };
  delete out.SagaTestRouter;
  delete out.SagaTestVault;
  delete out.pool;
}
out.usdc = usdc;
save();

// 3. wrapped PHRS, the pool and the vault
const wphrs = await deploy("SagaWPHRS", []);
const router = await deploy("SagaTestRouter", [wphrs, usdc]);
const vault = await deploy("SagaTestVault", [usdc]);
if ((await bal(wphrs, router)) === 0n) {
  const have = await bal(wphrs, account.address);
  if (have < SEED_PHRS) await wait("seed: wrap PHRS", await wallet.sendTransaction({ to: wphrs, value: SEED_PHRS - have }));
  await wait("seed: WPHRS → pool", await wallet.writeContract({ address: wphrs, abi: erc20, functionName: "transfer", args: [router, SEED_PHRS] }));
}
if ((await bal(usdc, router)) === 0n) await wait("seed: tUSDC → pool", await wallet.writeContract({ address: usdc, abi: erc20, functionName: "transfer", args: [router, SEED_USDC] }));

const rW = await bal(wphrs, router);
const rU = await bal(usdc, router);
out.pool = { wphrs: rW.toString(), usdc: rU.toString(), priceUsdcPerPhrs: (Number(rU) / 1e6 / (Number(rW) / 1e18)).toFixed(4) };
save();
console.log(`tUSDC  ${usdc}\nWPHRS  ${wphrs}\nrouter ${router}\nvault  ${vault}\npool: ${formatEther(rW)} WPHRS + ${formatUnits(rU, 6)} tUSDC (1 PHRS ≈ ${out.pool.priceUsdcPerPhrs} tUSDC)`);
