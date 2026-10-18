# @bifrostwallet/assets

Curated assets for Bifrost Wallet: providers, validators, tokens, dapps, and more as the catalog grows.

Zero runtime dependencies: JSON data plus pure lookup helpers. Logos are **not** bundled; published `logoURL` values are absolute (GitHub raw by default). For production or sensitive apps, mirror logos to your own bucket or CDN.

## Install

```bash
npm install @bifrostwallet/assets
```

Or install with Yarn or pnpm using the same package name.

## Quick start

```js
const {
  getProvider,
  getListedProviders,
  findProviderByValidator,
  getNativeToken,
  getToken,
  getContract,
  getContracts,
  CONTRACT_CATEGORY_LABELS,
} = require("@bifrostwallet/assets");

// Chain ids are CAIP-2 (e.g. "eip155:14", "eip155:19")
const bifrost = getProvider("eip155:14", "0x1650d2760baee638c034200dedcbe17b050d0364");
const logoURL = bifrost.logoURL; // already absolute
const byNode = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
); // → Bifrost Wallet
const picker = getListedProviders("eip155:14"); // listed: true only

const flr = getNativeToken("eip155:14"); // native gas token (address === null)
// WNAT / WFLR on Flare (lookup is case-insensitive)
const wflr = getToken("eip155:14", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d");

// Transaction-review names. Lookup is case-insensitive. null when unknown.
const pool = getContract("eip155:14", "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4");
// pool.projectName === "Bifrost Wallet"
// pool.contractName === "Collateral Pool"
// pool.category === "fassets"
// CONTRACT_CATEGORY_LABELS[pool.category] === "FAssets"
// pool.logoURL ends with "dapps/bifrostwallet-com/logo.webp"
// pool.logoHash is the SHA-256 of that dapp logo
const flareContracts = getContracts("eip155:14");
const everyContract = getContracts();
```

TypeScript / ESM:

```ts
import {
  getProvider,
  getListedProviders,
  findProviderByValidator,
  getNativeToken,
  getContract,
  CONTRACT_CATEGORY_LABELS,
} from "@bifrostwallet/assets";

const bifrost = getProvider("eip155:14", "0x1650d2760baee638c034200dedcbe17b050d0364");
const listed = getListedProviders("eip155:14");
const native = getNativeToken("eip155:14");
const pool = getContract("eip155:14", "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4");
// pool && CONTRACT_CATEGORY_LABELS[pool.category] === "FAssets"
```

## Provider picker vs confirmations

| UI | Rule |
| --- | --- |
| Provider **picker** / discovery | Show only `listed: true` (`getListedProviders`) |
| Already-selected provider (confirmations, details) | Show the entry even if `listed` is false (`getProvider` / `getProviders`) |

## Without NPM

**Not recommended.** Prefer the NPM package. GitHub raw is a fallback only:

```
https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-14/all.json
https://raw.githubusercontent.com/bifrostwallet/assets/main/data/tokens/eip155-14/all.json
```

Contract names are `getContract` / `getContracts`. The package bundles them at build time from `data/contracts/<chain>/<address>.json`. `projectName` is the dapp title, and `logoURL` / `logoHash` are copies of that dapp's logo. There is no `data/contracts/<chain>/all.json` and no `data/dapps/all.json`. Aggregates are only the provider and token lists above.

Relative `logoURL` values resolve against:

```
https://raw.githubusercontent.com/bifrostwallet/assets/main/data/
```

For production or sensitive applications, mirror logos to your own bucket or CDN instead of relying on GitHub’s CDN.

## Docs

Full integrator guide (data model, media format, optional CDN manifest):  
[docs.bifrostwallet.com: Consuming Assets](https://docs.bifrostwallet.com/list/consuming-assets)

Source of truth: [github.com/bifrostwallet/assets](https://github.com/bifrostwallet/assets)
