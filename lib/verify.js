import { decodeEventLog, isAddressEqual } from "viem";
import { ABI, TOKENS } from "./contracts.js";

/** Decoded `eventName` logs emitted by `address` in a receipt. */
export function eventsOf(receipt, address, abi, eventName) {
  const out = [];
  for (const log of receipt.logs ?? []) {
    if (!isAddressEqual(log.address, address)) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === eventName) out.push(ev.args);
    } catch {}
  }
  return out;
}

export const check = (label, ok, detail = "") => ({ label, ok: Boolean(ok), detail });

/** Token balance and allowance pinned to a block, so "before" and "after" bracket exactly one transaction. */
export async function balanceAt(client, token, owner, blockNumber) {
  return client.readContract({ address: token, abi: ABI.erc20, functionName: "balanceOf", args: [owner], blockNumber: BigInt(blockNumber) });
}

export async function allowanceAt(client, token, owner, spender, blockNumber) {
  return client.readContract({ address: token, abi: ABI.erc20, functionName: "allowance", args: [owner, spender], ...(blockNumber != null ? { blockNumber: BigInt(blockNumber) } : {}) });
}

export async function snapshot(client, owner, vault, blockNumber) {
  const at = blockNumber != null ? { blockNumber: BigInt(blockNumber) } : {};
  const [pros, wpros, usdc, shares] = await Promise.all([
    client.getBalance({ address: owner, ...at }),
    client.readContract({ address: TOKENS.WPROS.address, abi: ABI.erc20, functionName: "balanceOf", args: [owner], ...at }),
    client.readContract({ address: TOKENS.USDC.address, abi: ABI.erc20, functionName: "balanceOf", args: [owner], ...at }),
    client.readContract({ address: vault, abi: ABI.vault, functionName: "balanceOf", args: [owner], ...at }),
  ]);
  return { pros: pros.toString(), wpros: wpros.toString(), usdc: usdc.toString(), shares: shares.toString() };
}

/** Standard approve verification: Approval(owner, spender, value) in the receipt and the allowance read at that block. */
export async function verifyApprove(client, receipt, { token, owner, spender, amount, symbol }) {
  const evs = eventsOf(receipt, token, ABI.erc20, "Approval").filter((a) => isAddressEqual(a.owner, owner) && isAddressEqual(a.spender, spender));
  const allowance = await allowanceAt(client, token, owner, spender, receipt.blockNumber);
  return [
    check(`Approval event ${symbol} → ${short(spender)}`, evs.some((a) => a.value === BigInt(amount)), evs.length ? `value ${evs.at(-1).value}` : "no Approval event"),
    check(`allowance at block ${receipt.blockNumber}`, allowance === BigInt(amount), `${allowance} (expected ${amount})`),
  ];
}

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
