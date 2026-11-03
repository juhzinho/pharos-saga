import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CHAIN_MCP_URL } from "./contracts.js";

// Second opinion on every receipt (Pacific only): the official Pharos Chain MCP must report the same
// block hash, status and gas as the RPC the saga used. A fork transaction does not exist there, so the fork skips this.

export async function chainMcpVerifier(url = CHAIN_MCP_URL) {
  const client = new Client({ name: "pharos-saga", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout: 30_000 });

  async function receipt(hash) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await client.callTool({ name: "get_transaction_receipt", arguments: { hash } }, undefined, { timeout: 30_000 });
        const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        if (r.isError) throw new Error(text);
        return JSON.parse(text);
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
  }

  return {
    async checkReceipt(rpc) {
      const m = await receipt(rpc.transactionHash);
      if (!m) return { ok: false, detail: "Chain MCP has no receipt for this hash" };
      const status = m.status === "0x1" || m.status === 1 || m.status === "success" ? "success" : "reverted";
      const same = m.blockHash?.toLowerCase() === rpc.blockHash.toLowerCase() && BigInt(m.gasUsed) === rpc.gasUsed && status === rpc.status;
      return {
        ok: same,
        detail: same
          ? `same block ${BigInt(m.blockNumber)}, status ${status}, gas ${BigInt(m.gasUsed)}`
          : `MCP block ${m.blockHash} status ${status} gas ${BigInt(m.gasUsed)} vs RPC block ${rpc.blockHash} status ${rpc.status} gas ${rpc.gasUsed}`,
      };
    },
    close: () => client.close().catch(() => {}),
  };
}
