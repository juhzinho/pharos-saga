# Contracts used by the saga (Pharos Pacific Mainnet, chain 1672)

| Contract | Address | How it was confirmed |
|---|---|---|
| WPROS | `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0` | Official token registry (docs.pharos.xyz/getting-started/token-registry). WETH9-style: `deposit()` payable, `withdraw(uint256)`, `Deposit` / `Withdrawal` events. |
| USDC | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` | Official token registry, Circle USDC, 6 decimals. |
| FaroSwap DODORouteProxy | `0xA5cA5Fbe34e444F366B373170541ec6902b0F75c` | The contract real user swaps into the WPROS/USDC pool call (`mixSwap`, selector `0xff84aafa`); reverts with `DODORouteProxy: …` strings. |
| UniV3 adapter | `0x4fD44181839D24e7C8f4D1B9288379109Ec25FAE` | Decoded from the `mixAdapters` of real mainnet swaps. |
| WPROS/USDC 0.01% pool | `0x912c9aDe24D44d8922f0866D8Dcb079f1363f647` | `token0()` = WPROS, `token1()` = USDC, `fee()` = 100. |
| DODOApprove | `0xBF105f4ffBD3825f5433d074008B9A76237d849c` | The ERC-20 approval target of the proxy (`_DODO_APPROVE_PROXY_()` → `_DODO_APPROVE_()`). Approving the proxy itself does not work. |
| RockawayX USDC vault (Morpho) | `0x047cD0a91E9B92ED979189a6C8A120bf280f02E5` | ERC-4626, `asset()` = USDC. Morpho Vault V2: deposits route through an adapter into Morpho Blue (`0x18573f…4efb`). |
| SharpByte USDC vault (Morpho) | `0x15c25ED222fc498f672af5c3adb5ED0a96E1AFf1` | ERC-4626, `asset()` = USDC. |

## mixSwap layout

```
mixSwap(fromToken, toToken, fromTokenAmount, expReturnAmount, minReturnAmount,
        mixAdapters=[adapter], mixPairs=[pool], assetTo=[adapter, routeProxy],
        directions (0 = WPROS→USDC, 1 = USDC→WPROS),
        moreInfos=[abi.encode(uint256 0, abi.encode(tokenIn, tokenOut, uint24 100))],
        feeData=abi.encode(address 0, uint256 0), deadLine)
```

The proxy pays out at most `expReturnAmount`, so the saga sets it to the simulated quote and uses `minReturnAmount` as the slippage guard (1% by default).

## Things that are easy to get wrong

- `maxDeposit()` on these Morpho V2 vaults returns `0` even when deposits work. The saga relies on simulation and `previewDeposit()` instead.
- A swap with a minimum the pool cannot meet reverts with `DODORouteProxy: Return amount is not enough` — the saga treats that as slippage (re-quote once).
- The vault's own revert when it cannot pull USDC is the custom error `TransferFromReverted()` (selector `0xe65b7a77`).
- Pacific runs EIP-1559 with a 10 gwei base fee and a 0 tip.
