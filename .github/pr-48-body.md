## Summary

DEV-4908. Curated EVM token symbols now equal on-chain `symbol()`. 142 symbols changed. Only the symbol field was edited on the tokens that remain. Per-chain `all.json` files were regenerated from `info.json`.

`symbol()` is read as an ABI string when someone runs `./yarn check:tokens` locally with node URLs set. A bytes32 return is not supported and fails that run. CI does not set those URLs, so it does not read `symbol()` across the catalog.

| Chain | Symbols changed |
| --- | ---: |
| Ethereum (1) | 94 |
| Optimism (10) | 3 |
| Flare (14) | 4 |
| Coston (16) | 1 |
| Songbird (19) | 2 |
| BNB Smart Chain (56) | 16 |
| Polygon (137) | 11 |
| HyperEVM (999) | 3 |
| Base (8453) | 1 |
| Arbitrum (42161) | 7 |
| **Total** | **142** |

The `-e` symbols are now the on-chain values: Flare `0xfbda…` `USDC.e`, Coston `0xe148…` `USDC.e`, Flare `0x0b38…` `USDT`, Flare `0x1502…` `WETH`, Polygon `0x2791…` `USDC`.

`USD₮0` stays the on-chain symbol on Arbitrum `0xfd086bc7`, Flare, and HyperEVM.

## Exceptions

One curated symbol stays different from `symbol()`, listed in `SYMBOL_EXCEPTIONS`:

- MIST, Ethereum `0x88acdd2a6425c3faae4bc9650fd7e27e0bebb7ab`: the on-chain symbol is an emoji, which the symbol format does not allow.

## Removed

Dropped from the catalog:

- Symbols that contain a space, plus `$ZKP`: Polygon `ROUTE (PoS)`, Ethereum `FTX Token`, Ethereum and BNB Smart Chain `EKTA v2`, and Polygon `$ZKP`.
- Fantom mainnet (chain 250) and Fantom testnet (chain 4002). Mainnet was the whole token tree, 61 entries including native FTM. Testnet was the native FTM placeholder. Bifrost no longer supports Fantom. The Fantom RPC entry in the local token check and the Fantom blocklist entry are removed with mainnet. There was no separate testnet RPC entry.
- Every cDAI: Ethereum Compound Dai `0x5d3a536e4d6dbd6114cc1ead35777bab948e3643` and Compound SAI `0xf5dce57282a584d2746faf1593d3121fcac444dc`.
- Every KNC: Ethereum `0xdefa4e8a7bcba345f687a2f1456f5edd9ce97202` and `0xdd974d5c2e2928dea5f71b9825b8b646686bd200`, BNB Smart Chain `0xfe56d5892bdffc7bf58f2e84be1b2c32d21c308b`, and Polygon `0x1c954e8fe737f99f68fa1ccda3e51ebdb291948c`. The Fantom KNC tokens are included in the Fantom mainnet removal.
- Arbitrum MKR `0x2e9a6df78e42a30712c10a9dc4b1c8656f8f2879`: on-chain `symbol()` is a raw 64-hex value.
- Ethereum tokens whose `symbol()` is bytes32, which is not supported: MKR `0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2`, AVT `0x0d88ed6e74bbfd96b831231638b66c05571e824f`, DF `0x431ad2ff6a9c365805ebad47ee021148d6f7dbe0`, and SAI `0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359`.

## Tests

- Re-read every listed mismatch with `symbol()` before editing.
- CI runs `./yarn check:tokens` with no node URLs, same as `main`. It checks schema and logos. It does not call `symbol()` on the catalog. The test job timeout stays 10 minutes.
- A local run with node URLs reads `symbol()` as an ABI string. That run checked 1280 contracts: 0 schema errors, 0 symbol mismatches, 0 symbol read failures. Name and decimals mismatches stay advisory.
- `./yarn test`: 603 passed. `./yarn typecheck` and Biome passed.

When node URLs are set, the symbol check exits non-zero on a mismatch outside the exception list, on a symbol read that still fails after retries, and when `symbol()` is not an ABI string. An empty or NUL-only response is retried. A contract that reverts or returns no data is reported and does not fail the run.

## Release

Release this catalog only after the backend dot-safe change (DEV-4904) and the Topper/Amagi address matching (DEV-4983) are deployed.
