import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData } from "viem";
import { ABI, FAROSWAP, TOKENS } from "./contracts.js";

export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * FaroSwap mixSwap calldata for the 0.01% WPROS/USDC pool through the UniV3 adapter.
 * direction 0 = WPROS→USDC, 1 = USDC→WPROS (decoded from real mainnet swaps).
 * The proxy pays out at most expReturnAmount, so we pass our quote there and the slippage guard as minReturnAmount.
 */
export function encodeMixSwap({ fromToken, toToken, amount, expReturn, minReturn, direction, deadline }) {
  const tokenIn = direction === 0 ? TOKENS.WPROS.address : TOKENS.USDC.address;
  const tokenOut = direction === 0 ? TOKENS.USDC.address : TOKENS.WPROS.address;
  const moreInfo = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }],
    [0n, encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [tokenIn, tokenOut, FAROSWAP.poolFee])]
  );
  const feeData = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ZERO, 0n]);
  return encodeFunctionData({
    abi: ABI.routeProxy,
    functionName: "mixSwap",
    args: [fromToken, toToken, BigInt(amount), BigInt(expReturn), BigInt(minReturn), [FAROSWAP.adapter], [FAROSWAP.pool], [FAROSWAP.adapter, FAROSWAP.routeProxy], BigInt(direction), [moreInfo], feeData, BigInt(deadline)],
  });
}

export const minAfterSlippage = (quoted, bps) => (BigInt(quoted) * BigInt(10_000 - bps)) / 10_000n;

/**
 * Exact swap output by simulating the real mixSwap as `from` at `block`. `from` must hold the input and have
 * approved DODOApprove, which is why the saga quotes the swap right after its approve step.
 */
export async function simulateSwap(client, { from, direction, amount, deadline, blockNumber }) {
  const fromToken = direction === 0 ? TOKENS.WPROS.address : TOKENS.USDC.address;
  const toToken = direction === 0 ? TOKENS.USDC.address : TOKENS.WPROS.address;
  const data = encodeMixSwap({ fromToken, toToken, amount, expReturn: 10n ** 30n, minReturn: 1n, direction, deadline });
  const { data: out } = await client.call({ account: from, to: FAROSWAP.routeProxy, data, ...(blockNumber != null ? { blockNumber: BigInt(blockNumber) } : {}) });
  return decodeFunctionResult({ abi: ABI.routeProxy, functionName: "mixSwap", data: out });
}

/**
 * Quote for a plan, before the wallet holds or approved anything: the same pool, simulated as native PROS from
 * the WPROS contract (it always holds enough PROS). 1 PROS wraps to exactly 1 WPROS, so the output matches.
 */
export async function quoteProsToUsdc(client, amount, deadline) {
  const data = encodeMixSwap({ fromToken: NATIVE, toToken: TOKENS.USDC.address, amount, expReturn: 10n ** 30n, minReturn: 1n, direction: 0, deadline });
  const { data: out } = await client.call({ account: TOKENS.WPROS.address, to: FAROSWAP.routeProxy, data, value: BigInt(amount) });
  return decodeFunctionResult({ abi: ABI.routeProxy, functionName: "mixSwap", data: out });
}

export async function previewDeposit(client, vault, assets) {
  return client.readContract({ address: vault, abi: ABI.vault, functionName: "previewDeposit", args: [BigInt(assets)] });
}
