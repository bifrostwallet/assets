# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

The package is JSON plus lookup helpers, with no runtime dependencies. Chain ids in the public API are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `xrpl:0`). Each `logoURL` is a relative path such as `providers/eip155-14/<identity>/logo.webp`. Logo files are not in the npm tarball. Host them yourself and pass that base to `resolveAssetURL`.

- MIT license
- CommonJS entry (`index.js`) and TypeScript declarations (`index.d.ts`)
- No runtime dependencies

Listing rules live in the [GitHub README](https://github.com/bifrostwallet/assets/blob/main/README.md). Upload commands, the do/don't list, and optional logo-hash and signature checks live in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).

- [Usage](#usage)
- [Logo files on a version bump](#logo-files-on-a-version-bump)
- [Utils](#utils)
- [Supply chain security](#supply-chain-security)
- [License](#license)

## Usage

The main entry does not load `@bifrostwallet/assets/signatures`. `require("@bifrostwallet/assets")` returns the same functions as the named imports below.

An unknown CAIP-2 chain id throws. A missing record returns `null`. Directory names in `logoURL` use a hyphen (`eip155-14`) because they are file paths. The function arguments use a colon (`eip155:14`).

| Export | Returns |
| --- | --- |
| `getProviders(chainId)` | Every provider on that chain |
| `getProvider(chainId, identityAddress)` | One provider, or `null`. The address match is case-insensitive |
| `getListedProviders(chainId)` | Providers with `listed: true` |
| `getManagementGroupProviders(chainId)` | Providers with `managementGroup: true` |
| `findProviderByValidator(chainId, nodeId)` | The provider whose `validators` array contains that NodeID, or `null` |
| `getTokens(chainId)` | EVM tokens, or XRPL issued tokens when `chainId` is `"xrpl:0"` |
| `getToken(chainId, address)` | One EVM token, or `null`. The address match is case-insensitive |
| `getNativeToken(chainId)` | The gas token (`address: null`), or `null` |
| `getXrplToken(issuer, currency)` | One XRPL issued token, or `null`. Issuer and currency are exact case |
| `getTokenBlocklist()` | Blocklist entries (`chainPath`, `address`, `identifier`) |
| `getContracts(chainId?)` | One chain, or every chain when `chainId` is omitted |
| `getContract(chainId, address)` | One contract, or `null`. The address match is case-insensitive |
| `getDappCategories()` | Browser chips from `data/dapps/categories.json` |
| `resolveAssetURL(logoURL, baseURL?)` | `logoURL` joined to your base. See [Utils](#utils) |
| `PROVIDER_CHAIN_IDS` | `"eip155:14"` (Flare) and `"eip155:19"` (Songbird) |
| `TOKEN_CHAIN_IDS`, `CONTRACT_CHAIN_IDS` | CAIP-2 ids present in this version |
| `CONTRACT_CATEGORIES`, `CONTRACT_CATEGORY_LABELS` | Contract category ids and display names |
| `DAPP_CATEGORIES`, `DAPP_CATEGORY_LABELS` | Dapp chip ids and display names |
| `DEFAULT_ASSET_BASE_URL` | GitHub raw `…/data/` prefix. Pass your own base |

`@bifrostwallet/assets/signatures` exports `getProviderSignatures(chainId, identityAddress)`.

### Providers

Hide `listed: false` in picker and discovery UIs. Show a provider the user already selected, including one that is not listed, on confirmations and details.

```typescript
import {
  findProviderByValidator,
  getListedProviders,
  getManagementGroupProviders,
  getProvider,
  getProviders,
  resolveAssetURL,
} from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";

const listed = getListedProviders("eip155:14");
const all = getProviders("eip155:14");
const management = getManagementGroupProviders("eip155:14");

// This identity is Bifrost Wallet. null when this version has no such record.
const provider = getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
if (provider) {
  const logoURL = resolveAssetURL(provider.logoURL, base);
  console.log(provider.name, logoURL);
}

// The NodeID string must match the catalog, including the "NodeID-" prefix.
const byValidator = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
```

`getListedProviders` is the comparison list. `getProviders` includes providers that are not listed.

### Tokens

`getToken` looks up EVM contracts. The native gas token has `address: null` and is `getNativeToken`. XRPL issued tokens have no `address` and no `decimals`. `getXrplToken("rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", "eth")` is `null` because the currency case differs.

`getTokenBlocklist()` entries use the directory form in `chainPath` (`eip155-56`), which is the path shape, while lookup chain ids stay CAIP-2.

```typescript
import {
  getNativeToken,
  getToken,
  getTokenBlocklist,
  getTokens,
  getXrplToken,
  resolveAssetURL,
} from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";

const flareTokens = getTokens("eip155:14");
const flare = getNativeToken("eip155:14"); // FLR
const wflr = getToken(
  "eip155:14",
  "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d",
);
const issued = getXrplToken("rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", "ETH");
const blocklist = getTokenBlocklist();

if (wflr) {
  const logoURL = resolveAssetURL(wflr.logoURL, base);
  console.log(flare?.symbol, wflr.symbol, issued?.name, blocklist.length, logoURL);
}
console.log(flareTokens.length);
```

### Dapps

`getDappCategories()` returns the hand-ordered chips (`featured`, `dex`, `lending`, `yield`, `staking`, `bridges`, `marketplaces`, `social`, `games`, `other`). A chip's `dapps` array is slug order. A slug may appear in more than one chip. Some chips are empty.

There is no per-dapp lookup. Title, URL, description, and chains stay in `data/dapps/<slug>/info.json` in git.

```typescript
import { DAPP_CATEGORY_LABELS, getDappCategories } from "@bifrostwallet/assets";

const chips = getDappCategories();
const dex = chips.find((chip) => chip.id === "dex");
const dexLabel = DAPP_CATEGORY_LABELS.dex; // "DEX"
console.log(dexLabel, dex?.dapps);
```

### Contracts

`getContract` reads the curated name catalog. One call returns `project`, `projectName`, `logoURL`, and `logoHash`. The package build fills those in (`projectName` is the project `name`). `category` is a `CONTRACT_CATEGORIES` id. Display the label from `CONTRACT_CATEGORY_LABELS`. `logoURL` is `contracts/projects/<slug>/logo.webp`, or that contract's own `logo.webp` when the file exists.

```typescript
import {
  CONTRACT_CATEGORY_LABELS,
  getContract,
  getContracts,
  resolveAssetURL,
} from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";

const flareContracts = getContracts("eip155:14");
const allContracts = getContracts();

const router = getContract(
  "eip155:14",
  "0x03e2ec137c6ab82978d52edb7b504ad2deb13f96",
);
if (router) {
  const categoryLabel = CONTRACT_CATEGORY_LABELS[router.category]; // "Yield"
  const logoURL = resolveAssetURL(router.logoURL, base);
  console.log(router.projectName, router.contractName, categoryLabel, logoURL);
}
console.log(flareContracts.length, allContracts.length);
```

### Provider signatures

Operator signatures ship on a separate entry so a picker import does not download them. `getProviderSignatures` returns `null` when this version has no signature file for that identity. Some listings stay unsigned until 31 December 2026. Recovering the EIP-712 signer is described in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md). `viem` is a dev dependency of this repository, not of the published package.

```typescript
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const record = getProviderSignatures(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
```

## Logo files on a version bump

> [!WARNING]
> Bumping `@bifrostwallet/assets` without uploading logos from the matching git tag to storage you control is an incomplete upgrade. The tag is `v` plus the package version. Logo files are not in the npm tarball.
>
> A path that is new in that version 404s. A path you already uploaded can keep the previous bytes, and `logoHash` will not match when the logo changed.
>
> Copy every logo tree you actually serve, and keep the relative paths:
>
> - `data/providers/**/logo.webp` (provider icons)
> - `data/tokens/**/logo.webp` (EVM and XRPL token icons)
> - `data/dapps/**/logo.webp` (dapp icons)
> - `data/contracts/**/logo.webp` (contract project icons and per-contract icons)

Pin one version so a newer catalog cannot arrive on its own. Commit the lockfile.

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`

pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`

Host those files yourself and pass that origin to `resolveAssetURL`. The helpers do not fetch `all.json` or logos from GitHub raw or from Bifrost's CDN. Copy commands are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).

## Utils

`resolveAssetURL` is the published helper that is not a catalog lookup. There is no separate utils entry point. Pass a listing's `logoURL`, such as `provider.logoURL`.

```typescript
import { getProvider, resolveAssetURL } from "@bifrostwallet/assets";

// This identity is Bifrost Wallet. null when this version has no such record.
const provider = getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
if (provider) {
  const href = resolveAssetURL(provider.logoURL, "https://cdn.example.com/assets/");
  // https://cdn.example.com/assets/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp
}
```

The base is the directory that contains `providers/`, `tokens/`, `dapps/`, and `contracts/`. The same call works for a token, dapp, or contract `logoURL`.

`DEFAULT_ASSET_BASE_URL` is `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/`. `resolveAssetURL` uses it when the base is omitted or blank. Pass your base on every call.

An absolute `logoURL` whose path contains `providers/`, `tokens/`, `dapps/`, or `contracts/` is reduced to that relative path and joined to your base. The published listings already store relative paths.

## Supply chain security

- **Releases.** [`.github/workflows/release.yml`](https://github.com/bifrostwallet/assets/blob/main/.github/workflows/release.yml) stages `@bifrostwallet/assets` with npm Trusted Publishing (OIDC, `id-token: write`). The publish step sets `NPM_CONFIG_PROVENANCE=true` and runs `npm stage publish ./dist --access public --tag beta`. A GitHub Release whose tag is `v` plus the package version triggers it, as does a manual run with `publish=true`. A manual run with `publish=false` only builds `dist/`. A maintainer approves the staged version on npmjs.com before it is installable. The workflow refuses a version that is not `alpha`, `beta`, or `rc` until provider signature checks are strict. Confirm the green check on the npm version page, or run `npm audit signatures`. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/).
- **Dependencies.** The published package has zero runtime dependencies. `dist/package.json` is written with `"dependencies": {}`, and the build fails if that manifest declares `dependencies`, `devDependencies`, or `peerDependencies`.
- **Dev dependencies.** They are pinned to exact versions and are left out of `dist/package.json`, so an end-user install does not install them. They exist for curation, lint, and the package build:
  - `@biomejs/biome` — lint and format
  - `@google-cloud/storage` — maintainer bucket upload
  - `@types/node` — Node types for the TypeScript build
  - `bs58` — base58 checks in curation scripts (NodeIDs and XRPL addresses)
  - `typescript` — compile and typecheck
  - `viem` — chain reads and EIP-712 recovery in curation scripts

This package has no third-party security audit. Report vulnerabilities privately to **security@bifrostwallet.com**. See [SECURITY.md](https://github.com/bifrostwallet/assets/blob/main/SECURITY.md).

## License

MIT. Copyright (c) 2026 Bifrost Software Ltd. See [LICENSE](https://github.com/bifrostwallet/assets/blob/main/LICENSE).
