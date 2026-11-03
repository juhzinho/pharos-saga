import { createPublicClient, defineChain, http, keccak256 } from "viem";
import { CHAIN_ID, PACIFIC_RPC } from "./contracts.js";

// Two networks, one code path:
//   pacific  the real Pharos Pacific Mainnet (chain 1672). Real funds, real explorer links.
//   fork     a local Anvil fork of Pacific Mainnet at the latest block. Same contracts, same pool, same vault
//            state, with throw-away test accounts. Used for tests, demos and fault injection.

export const NETWORKS = {
  pacific: { id: "pacific", label: "Pharos Pacific Mainnet", rpc: process.env.PHAROS_RPC_URL ?? PACIFIC_RPC, explorer: true },
  fork: { id: "fork", label: "Local fork of Pharos Pacific Mainnet (Anvil)", rpc: process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545", explorer: false },
};

export function chainFor(network) {
  return defineChain({
    id: CHAIN_ID,
    name: network.label,
    nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
  });
}

export function publicClientFor(network) {
  return createPublicClient({ chain: chainFor(network), transport: http(network.rpc, { timeout: 30_000, retryCount: 0 }) });
}

/** Latest base fee and suggested tip. Pharos Pacific runs EIP-1559 with a 10 gwei base fee and 0 tip. */
export async function readFees(client) {
  const block = await client.getBlock({ blockTag: "latest" });
  let tip = 0n;
  try {
    tip = BigInt(await client.request({ method: "eth_maxPriorityFeePerGas", params: [] }));
  } catch {}
  return { baseFee: block.baseFeePerGas ?? 0n, priorityFee: tip, block: block.number };
}

/** Signs locally and returns { raw, hash } without broadcasting, so the hash is logged before anything leaves. */
export function localSigner(account, client) {
  return {
    address: account.address,
    kind: "local-key",
    async sign(tx) {
      const raw = await account.signTransaction({ ...tx, chainId: CHAIN_ID, type: "eip1559" });
      return { raw, hash: keccak256(raw) };
    },
    broadcast: (raw) => client.request({ method: "eth_sendRawTransaction", params: [raw] }),
  };
}

/** Anvil-only helpers used by the fault injector (a real gas spike on the fork). */
export const anvil = {
  async spikeBaseFee(client, weiPerGas) {
    await client.request({ method: "anvil_setNextBlockBaseFeePerGas", params: [`0x${BigInt(weiPerGas).toString(16)}`] });
    await client.request({ method: "evm_mine", params: [] });
  },
  async isAnvil(client) {
    try {
      const v = await client.request({ method: "web3_clientVersion", params: [] });
      return /anvil/i.test(v);
    } catch {
      return false;
    }
  },
};
