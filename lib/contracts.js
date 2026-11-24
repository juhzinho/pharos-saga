import { getAddress, parseAbi } from "viem";
import { existsSync, readFileSync } from "node:fs";

// Which chain the saga runs on: Pacific (or its fork) by default; `--network atlantic` (or SAGA_NET=atlantic) selects
// Pharos Atlantic Testnet, where FaroSwap and Morpho are not deployed. There the saga uses test contracts with the
// same interfaces (contracts/atlantic/SagaTest.sol, deployed by scripts/deploy-atlantic.mjs): a WETH9-style WPHRS,
// a router with FaroSwap's mixSwap signature over one constant-product WPHRS/USDC pool, and an ERC-4626 USDC vault.
const argNet = (() => {
  const i = process.argv.indexOf("--network");
  return i >= 0 ? process.argv[i + 1] : null;
})();
export const SAGA_NET = process.env.SAGA_NET ?? (argNet === "atlantic" ? "atlantic" : "pacific");
const ATL = SAGA_NET === "atlantic";
const DEP_FILE = new URL("../deployments/atlantic.json", import.meta.url);
const DEP = ATL && existsSync(DEP_FILE) ? JSON.parse(readFileSync(DEP_FILE, "utf8")) : null;
if (ATL && !DEP?.SagaTestVault) throw new Error("Atlantic test contracts are not deployed yet: node scripts/compile-atlantic.mjs && node scripts/deploy-atlantic.mjs");
export const ATLANTIC_RPC = "https://atlantic.dplabs-internal.com";
export const NATIVE_SYMBOL = ATL ? "PHRS" : "PROS";
export const WRAPPED_SYMBOL = ATL ? "WPHRS" : "WPROS";
export const DEX_NAME = ATL ? "the saga test pool" : "FaroSwap";

// Pharos Pacific Mainnet contracts used by the saga. Every address below was checked on chain:
// - WPROS / USDC: official token registry (docs.pharos.xyz/getting-started/token-registry).
// - FaroSwap: DODORouteProxy + UniV3 adapter + the 0.01% WPROS/USDC pool, the route real user swaps take
//   (mixSwap selector 0xff84aafa). The ERC20 approval target is DODOApprove, read from the proxy.
// - Morpho: RockawayX and SharpByte USDC vaults (ERC-4626, Morpho Vault V2), asset() = USDC.

export const CHAIN_ID = ATL ? 688689 : 1672;
export const EXPLORER = ATL ? "https://atlantic.pharosscan.xyz" : "https://www.pharosscan.xyz";
export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const CHAIN_MCP_URL = "https://mcp.pharos.xyz/mcp";

export const TOKENS = ATL
  ? {
      WPROS: { symbol: "WPHRS", address: getAddress(DEP.SagaWPHRS), decimals: 18 },
      USDC: { symbol: "USDC", address: getAddress(DEP.usdc), decimals: 6 },
    }
  : {
      WPROS: { symbol: "WPROS", address: getAddress("0x52c48d4213107b20bc583832b0d951fb9ca8f0b0"), decimals: 18 },
      USDC: { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6 },
    };

export const FAROSWAP = ATL
  ? { routeProxy: getAddress(DEP.SagaTestRouter), adapter: getAddress(DEP.SagaTestRouter), pool: getAddress(DEP.SagaTestRouter), dodoApprove: getAddress(DEP.SagaTestRouter), poolFee: 3000 }
  : {
  routeProxy: getAddress("0xa5ca5fbe34e444f366b373170541ec6902b0f75c"),
  adapter: getAddress("0x4fD44181839D24e7C8f4D1B9288379109Ec25FAE"),
  pool: getAddress("0x912c9aDe24D44d8922f0866D8Dcb079f1363f647"),
  dodoApprove: getAddress("0xbf105f4ffbd3825f5433d074008b9a76237d849c"),
  poolFee: 100, // 0.01%
};

export const VAULTS = ATL
  ? { test: { id: "test", name: "Saga Test USDC Vault (ERC-4626)", symbol: "stUSDC", address: getAddress(DEP.SagaTestVault) } }
  : {
  rock: { id: "rock", name: "RockawayX USDC (Morpho)", symbol: "roxUSDC", address: getAddress("0x047cD0a91E9B92ED979189a6C8A120bf280f02E5") },
  sharp: { id: "sharp", name: "SharpByte USDC (Morpho)", symbol: "sbUSDC", address: getAddress("0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1") },
};

export const ABI = {
  wpros: parseAbi([
    "function deposit() payable",
    "function withdraw(uint256 wad)",
    "event Deposit(address indexed dst, uint256 wad)",
    "event Withdrawal(address indexed src, uint256 wad)",
  ]),
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event Approval(address indexed owner, address indexed spender, uint256 value)",
  ]),
  vault: parseAbi([
    "function asset() view returns (address)",
    "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
    "function previewDeposit(uint256 assets) view returns (uint256)",
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  ]),
  routeProxy: parseAbi([
    "function mixSwap(address fromToken, address toToken, uint256 fromTokenAmount, uint256 expReturnAmount, uint256 minReturnAmount, address[] mixAdapters, address[] mixPairs, address[] assetTo, uint256 directions, bytes[] moreInfos, bytes feeData, uint256 deadLine) payable returns (uint256)",
  ]),
};

export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (address) => `${EXPLORER}/address/${address}`;
