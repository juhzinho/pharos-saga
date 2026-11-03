import { parseEther } from "viem";
import { FAROSWAP, TOKENS, VAULTS } from "../lib/contracts.js";
import { NETWORKS, publicClientFor, readFees } from "../lib/chain.js";
import { minAfterSlippage, previewDeposit, quoteProsToUsdc } from "../lib/quote.js";

// GET /api/plan?amount=2&vault=rock — what the saga would do on Pharos Pacific Mainnet right now.
// Read-only: the swap is quoted by simulating the real FaroSwap mixSwap, shares by the vault's previewDeposit.
const GAS = { wrap: 27842, "approve-wpros": 46111, swap: 194937, "approve-usdc": 55437, deposit: 315387 };

export default async function handler(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const amountText = q.get("amount") ?? "2";
  const vault = VAULTS[q.get("vault") ?? "rock"];
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (!/^\d{1,4}(\.\d{1,18})?$/.test(amountText) || Number(amountText) <= 0 || Number(amountText) > 1000) return send(400, { ok: false, error: "amount must be a number between 0 and 1000 PROS" });
  if (!vault) return send(400, { ok: false, error: "vault must be rock or sharp" });
  try {
    const client = publicClientFor(NETWORKS.pacific);
    const amount = parseEther(amountText);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    const [usdc, fees, block] = await Promise.all([quoteProsToUsdc(client, amount, deadline), readFees(client), client.getBlockNumber()]);
    const shares = await previewDeposit(client, vault.address, usdc);
    const gas = Object.values(GAS).reduce((a, b) => a + b, 0);
    send(200, {
      ok: true,
      network: "pacific",
      block: block.toString(),
      baseFeeWei: fees.baseFee.toString(),
      amountWei: amount.toString(),
      usdc: usdc.toString(),
      minUsdc: minAfterSlippage(usdc, 100).toString(),
      shares: shares.toString(),
      vault: { id: vault.id, name: vault.name, symbol: vault.symbol, address: vault.address },
      priceUsdcPerPros: ((usdc * 10n ** 18n) / amount).toString(),
      gasUnits: gas,
      gasWei: (BigInt(gas) * fees.baseFee).toString(),
      contracts: { wpros: TOKENS.WPROS.address, usdc: TOKENS.USDC.address, routeProxy: FAROSWAP.routeProxy, dodoApprove: FAROSWAP.dodoApprove, pool: FAROSWAP.pool },
    });
  } catch (e) {
    send(503, { ok: false, error: `Pharos RPC did not answer: ${e.shortMessage ?? e.message}` });
  }
}
