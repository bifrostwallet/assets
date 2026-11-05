# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

The package is JSON plus lookup helpers, with no runtime dependencies. Chain ids in the public API are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `xrpl:0`). Each `logoURL` is a relative path such as `providers/eip155-14/<identity>/logo.webp`. Logo files are not in the npm tarball. Host them yourself and pass that base to `resolveAssetURL`.

- MIT license
- CommonJS entry (`index.js`) and TypeScript declarations (`index.d.ts`)
- No runtime dependencies

Upload commands, the do/don't list, and optional logo-hash and signature checks are in [CONSUMERS.md](CONSUMERS.md). Listing rules for providers, tokens, dapps, and contracts start at [FTSO data providers](#ftso-data-providers).

- [Usage](#usage)
- [Logo files on a version bump](#logo-files-on-a-version-bump)
- [Utils](#utils)
- [Supply chain security](#supply-chain-security)
- [FTSO data providers](#ftso-data-providers)
- [Dapps](#dapps)
- [Tokens](#tokens)
- [Contracts](#contracts)
- [Repository layout](#repository-layout)
- [Self-serve pipeline](#self-serve-pipeline)
- [Development](#development)
- [Vulnerability disclosure](#vulnerability-disclosure)
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

Operator signatures ship on a separate entry so a picker import does not download them. `getProviderSignatures` returns `null` when this version has no signature file for that identity. Some listings stay unsigned until 31 December 2026. Recovering the EIP-712 signer is described in [CONSUMERS.md](CONSUMERS.md). `viem` is a dev dependency of this repository, not of the published package.

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

pnpm uses `--save-exact` as well. Yarn uses `--exact`. The three install lines are in [CONSUMERS.md](CONSUMERS.md#1-pin-the-package).

Host those files yourself and pass that origin to `resolveAssetURL`. The helpers do not fetch `all.json` or logos from GitHub raw or from Bifrost's CDN. Copy commands are in [CONSUMERS.md](CONSUMERS.md).

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

- **Releases.** [`.github/workflows/release.yml`](.github/workflows/release.yml) stages `@bifrostwallet/assets` with npm Trusted Publishing (OIDC, `id-token: write`). The publish step sets `NPM_CONFIG_PROVENANCE=true` and runs `npm stage publish ./dist --access public --tag beta`. A GitHub Release whose tag is `v` plus the package version triggers it, as does a manual run with `publish=true`. A manual run with `publish=false` only builds `dist/`. A maintainer approves the staged version on npmjs.com before it is installable. The workflow refuses a version that is not `alpha`, `beta`, or `rc` until provider signature checks are strict. Confirm the green check on the npm version page, or run `npm audit signatures`. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/).
- **Dependencies.** The published package has zero runtime dependencies. `dist/package.json` is written with `"dependencies": {}`, and the build fails if that manifest declares `dependencies`, `devDependencies`, or `peerDependencies`.
- **Dev dependencies.** They are pinned to exact versions and are left out of `dist/package.json`, so an end-user install does not install them. They exist for curation, lint, and the package build:
  - `@biomejs/biome` — lint and format
  - `@google-cloud/storage` — maintainer bucket upload
  - `@types/node` — Node types for the TypeScript build
  - `bs58` — base58 checks in curation scripts (NodeIDs and XRPL addresses)
  - `typescript` — compile and typecheck
  - `viem` — chain reads and EIP-712 recovery in curation scripts

This package has no third-party security audit. Report vulnerabilities privately to **security@bifrostwallet.com**. See [SECURITY.md](SECURITY.md).

## FTSO Data Providers

One listing covers your **provider identity** and nested **validator NodeIDs**. Validators are not a separate listing type.

### Adding your provider (self-serve)

Use the listing form on bifrostwallet.com; no GitHub account or repository interaction required. Submissions are reviewed by curators and not guaranteed a listing.

1. Open [bifrostwallet.com/list/provider](https://bifrostwallet.com/list/provider)
2. Connect the wallet holding your identity address (or paste the address); entity data is fetched from the EntityManager and the network is detected automatically
3. Fill in name, description, website, social links and upload a logo ([image requirements](#logo-requirements))
4. Confirm the [listing acknowledgement](#listing-acknowledgement) (required checkbox)
5. Sign the EIP-712 `ProviderListing` typed data under [Ownership signatures](#ownership-signatures) with the wallet holding your **identity address**
6. Submit: your listing is verified and curated into [`bifrostwallet/assets`](https://github.com/bifrostwallet/assets), and goes live once reviewed

Submissions are accepted only when signed by the identity address itself and when that address is a registered entity on-chain. Submitting again updates your pending submission. To change your listing later, go through the app again.

### Ownership signatures

Every provider entry carries a `signatures.json` proving control of the identity address. The requirement is a **self-signature** by that address: EIP-712 (`eth_signTypedData_v4`) over `ProviderListing`.

The domain is `name` `"Bifrost Assets"`, `version` `"1"`, `chainId` (the id in `eip155-<id>`; Flare is 14, Songbird is 19), and `salt` `keccak256` of the UTF-8 string `https://bifrostwallet.com` (`0xffc5336f20c2026b0f53d269def3cdffa3ca99b07e238af05f263a89517104f7`). The example below uses Flare's chain id.

```json
{
  "domain": {
    "name": "Bifrost Assets",
    "version": "1",
    "chainId": 14,
    "salt": "0xffc5336f20c2026b0f53d269def3cdffa3ca99b07e238af05f263a89517104f7"
  },
  "primaryType": "ProviderListing",
  "types": {
    "ProviderListing": [
      { "name": "name", "type": "string" },
      { "name": "description", "type": "string" },
      { "name": "websiteURL", "type": "string" },
      { "name": "logoHash", "type": "bytes32" },
      { "name": "identityAddress", "type": "address" },
      { "name": "linksJson", "type": "string" },
      { "name": "acknowledgedResponsibilities", "type": "bool" },
      { "name": "contentHash", "type": "bytes32" }
    ]
  },
  "message": {
    "name": "Example",
    "description": "Example provider",
    "websiteURL": "https://example.com",
    "logoHash": "0x<64 lowercase hex chars>",
    "identityAddress": "0x<40 lowercase hex chars>",
    "linksJson": "{\"x\":\"https://x.com/example\"}",
    "acknowledgedResponsibilities": true,
    "contentHash": "0x<64 lowercase hex chars>"
  }
}
```

`logoHash` is the SHA-256 of the stored `logo.webp` bytes, as 64 lowercase hex characters. The typed-data field is that digest with a `0x` prefix.

`messageHash` in `signatures.json` and `contentHash` are the same value: `0x` plus the SHA-256 of one canonical JSON string. That string is `JSON.stringify` of these keys, in order: `name`, `description`, `logoHash` (the unprefixed hex), `websiteURL`, `links`, `identityAddress`, `acknowledgedResponsibilities`. `links` includes only the links you set, with keys in this order: `github`, `x`, `discord`, `telegram`, `youtube`, `reddit`, `linkedin`, `tiktok`. `linksJson` is `JSON.stringify` of that same `links` object, and the typed-data `contentHash` is `messageHash` as `bytes32`.

Changing any of these fields requires a new signature. Anything not listed here is not signed and can change without a new signature (for example on-chain data refreshed nightly).

CI checks every signature with `yarn verify:providers`.

**Deadline:** entries that predate the public launch of this repository are grandfathered until **31 December 2026**. Listed providers without a self-signature and `domainLinked: true` are set `listed: false` after 31 December 2026.

### Logo requirements

**Upload PNG or WebP → store WebP.** Provide at least **128×128**; larger images are fine. The listing form cover-fits and converts to the catalog form before you hash and sign:

- **128×128** WebP. A transparent background is recommended so the mark composites on any surface. Opaque WebP, including a solid white background, is valid.
- Maximum file size **24 KB**
- Stored as `logo.webp`; `logoHash` is the SHA-256 of those WebP bytes

New intake submissions that are not exactly this final WebP form are rejected.

Catalog media in this repository is **WebP** (`logo.webp`).

### Extended requirements

##### Trustworthy

- The team developing and running the provider is known to other providers
- **Domain linkage** (same payload for file and DNS; see below). Nightly refresh always checks both methods and sets unsigned `domainLinked` when at least one matches and the two do not contradict for this identity. That edit is proposed on the `nightly/fsp-delist` pull request with the delist and chain-drift updates; it is not pushed to the default branch.

###### Domain linkage format

Publish the **same** allowlisted payload in either or both places (both are always verified):

| Where | What |
| --- | --- |
| HTTPS file | `https://<your-site>/.well-known/providers.txt` |
| DNS TXT | Name `_providers.<your-site>` → TXT value |

Payload: one or more `eip155:<chainId>:<identity>` entries, comma-separated.

```bash
curl -sS https://example.com/.well-known/providers.txt
# eip155:14:0x…,eip155:19:0x…

dig +short TXT _providers.example.com
# "eip155:14:0x…,eip155:19:0x…"
```

Check a curated identity with `./yarn verify:provider-domains --identity 0x…`. Full walkthrough: [docs.bifrostwallet.com](https://docs.bifrostwallet.com/) (FTSO provider listing).

##### Resilient

- At most one vote-power-attracting FTSO/FSP identity per team per network
- Protocol submissions use infrastructure the team controls (not a shared public RPC used by other providers)

Acknowledged in the listing form before signing (see [listing acknowledgement](#listing-acknowledgement)).

##### Independent

- No cooperation with or shared infrastructure with other FTSO/FSP providers on the same network
- Own FDC, FSP, feed provider, validators, and RPC node
- A single provider identity per network

Acknowledged in the listing form before signing (signed `acknowledgedResponsibilities`).

##### Available

Listed providers are expected to stay operationally active: submit and earn FSP rewards with healthy uptime, and run the stack that makes that possible (FDC, FSP, feed provider, validators, RPC node), with enough self-bond, vote power, and stake to participate meaningfully.

Operational participation is judged from Flare Systems Protocol data ([fsp-rewards](https://github.com/flare-foundation/fsp-rewards)), not from self-attested uptime:

- Providers whose FSP rewards are burned (`eligibleForReward: false` in the latest `passes.json`) are delisted via an automated catalog update
- Curators may also delist providers that persistently fail the advisory eligibility screen (`./yarn check:providers`); such providers are relisted when healthy again
- An operator whose current FTSO/FSP delegation fee, or any currently validating Flare validator fee, is above 50% is delisted under [Bifrost's delegation-fee recommendation](#delegation-fees)

##### Delegation fees

This cap is **Bifrost's own listing recommendation**. It is not a Flare or Songbird protocol rule. The protocols allow a higher delegation fee; Bifrost chooses not to list operators that charge one.

An operator must not stay `listed: true` when either of these is true:

- Its **current** FTSO/FSP delegation fee is strictly above **50%**. Exactly 50% may stay listed.
- On Flare, **any** of its validators that is **currently validating** on the P-chain (a NodeID in `validators` that `platform.getCurrentValidators` still returns) charges a delegation fee strictly above **50%**. One validator over the cap delists the whole operator. Nodes that are not currently validating do not count. Songbird has no P-chain staking, so only the FTSO/FSP fee applies there.

**20%** is the usual fee. Fees below 20% are allowed. There is no lower bound.

The nightly catalog refresh reads the FTSO fee from `WNatDelegationFee.getVoterCurrentFeePercentage` (BIPS, resolved through `FlareContractRegistry`) and Flare validator fees from `platform.getCurrentValidators` (`delegationFee`, a percent such as `20.0000`). Operators over the cap are proposed as `listed: false` on the `nightly/fsp-delist` pull request, with the reason in the pull request body. A curator still merges that pull request. `./yarn check:providers` prints the same check as an advisory and does not fail on it.

### Listed in Bifrost Wallet

To be **Listed in Bifrost Wallet**, curators require **private outreach on file** (submitted via the listing portal; end-to-end encrypted in the browser and encrypted at rest, not published here) **and** `domainLinked: true`, in addition to the Trustworthy / Resilient / Independent / Available bar above. Domain linkage and outreach are not self-granted on intake.

**Initial listing guidelines** (curator bar for new `listed: true`; not auto-applied by CI):

| Network | Guideline |
| --- | --- |
| **Flare** | Self-bond ≥ **10M FLR**; ≥ **2** validators; ≥ **20** unique P-chain stakers **and** ≥ **2M FLR** external stake; WFLR vote power ≥ **100M FLR**; prefer brands that already have a Songbird (canary) catalog entry |
| **Songbird** | WSGB vote power ≥ **50M** |

**Grandfathering:** providers that were listed before this repository went public keep `listed: true` until **31 December 2026** without meeting the domain linkage and ownership signature requirements. Listed providers without a self-signature and `domainLinked: true` are set `listed: false` after 31 December 2026. Delisted providers are relisted once they meet the requirements again.

### Recommendations for developers

If you're a wallet or dapp developer using our curated provider data:

1. **Hide** providers with `listed: false` from picker / discovery UIs.
2. **Show** all providers in contexts where a choice has already been made (confirmations, transaction details).

Install, lookups, and logo hosting: [Usage](#usage). Upload commands: [CONSUMERS.md](CONSUMERS.md).

## Dapps

Self-serve dapp bookmarks via [bifrostwallet.com/list/dapp](https://bifrostwallet.com/list/dapp). Contact details are sealed privately; public fields are title, description, URL, chains, and logo. Listing guide: [docs.bifrostwallet.com: Dapp](https://docs.bifrostwallet.com/list/dapp).

Each dapp lives at `data/dapps/<slug>/` with `info.json` and one `logo.webp`. `info.json` keeps a relative `logoURL` (`dapps/<slug>/logo.webp`) and `logoHash` (SHA-256 of that file). `title` is the display name. There is no per-dapp `category` or `featured` flag. Dapps have no `all.json`. Aggregates are only for tokens and providers.

Browser chips live only in the hand-edited `data/dapps/categories.json`: an ordered array of `{ id, label, dapps }`. Chip order is `featured`, `dex`, `lending`, `yield`, `staking`, `bridges`, `marketplaces`, `social`, `games`, `other`. Order inside a chip is curated and is never sorted. A dapp may appear in more than one chip. Every dapp folder must appear in at least one chip. `./yarn check:contracts` fails otherwise. `./yarn check:dapps` warns in that case and still exits 0. `bridges` is cross-chain token and message transfer. `marketplaces` is NFT marketplaces only. `other` is the fallback chip. The NPM package ships that file as `getDappCategories()`. It is not an aggregate `all.json`.

```bash
./yarn check:dapps
```

`./yarn check:dapps` fails when an `info.json` breaks the schema (title, description, https URL, `logoURL`, `logoHash`, allowed CAIP-2 chains), when `logo.webp` is missing, not WebP, the wrong size, or a different hash, and when `categories.json` names a missing slug, repeats a slug inside one chip, or uses a category id outside `DAPP_CATEGORIES`.

Place a dapp from its official site. Do not filter chips by network.

## Tokens

Token metadata is curated by Bifrost Wallet (not self-serve). EVM catalogs live under `data/tokens/eip155-<id>/<address|native>/` with `info.json` + `logo.webp`, per-chain `all.json`, and `data/tokens/blocklist.json`. The native gas token uses `address: null` and directory `native/` (no separate `native` boolean).

XRPL mainnet issued tokens live under `data/tokens/xrpl-0/<issuer>/<currency>/`. `issuer` is the classic r-address in exact case. `currency` is the on-ledger code: a 3-character code in exact case, or 40-hex uppercase. There is no `address` field. Lookup is `getXrplToken(issuer, currency)` and keeps that exact case. EVM lookup stays `getToken(chain, address)`. `symbol` is the decoded currency. XRPL tokens carry no decimals. AMM LP tokens (40-hex currency codes starting with `03`) are not listed.

Every `info.json` **must** include `coingeckoId` (`string` or `null`). CoinGecko is only for id resolution / optional price hints, never for growing the list or overriding on-chain name/symbol/decimals.

Curators add one EVM token with the chain directory and the contract address:

```bash
./yarn add:token eip155-1 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
```

The command reads that token's name, symbol, and decimals from the chain's `*_NODE_URL`. It trims both strings, keeps internal spaces and `.`, and refuses an empty value, a bytes32 `name()` or `symbol()`, or a symbol already used on that chain. The logo comes from CoinGecko, then [Trust Wallet's assets repository](https://github.com/trustwallet/assets), and is stored as 128×128 WebP at most 24 KB (`cwebp` from libwebp, same as dapp logos). It writes `info.json` and `logo.webp` for that address only and does not read the rest of the catalog on-chain.

```bash
./yarn check:tokens -- --skip-onchain
```

`./yarn check:tokens` rejects a new duplicate EVM symbol. Symbols that were already duplicated stay allowed.

## Contracts

Contract names are shown in Bifrost Wallet transaction-review modals. The wallet checks the user's address book first. This catalog is the fallback that turns a hex address into a readable name such as `Bifrost Wallet: Collateral Pool`.

Entries live at `data/contracts/eip155-<id>/<lowercase-address>.json` (path-safe CAIP-2). The directory is the chain: `eip155-14` is CAIP-2 `eip155:14`. The filename is the address. Store `address`, `contractName`, `category`, and an optional `project` slug. Do not store `chain`, `dapp`, `projectName`, `logoURL`, or `logoHash`. There is no aggregate `all.json`. There is no `listed` flag and no provider link. Token contracts live in `tokens/`, not `contracts/`.

`project` names a folder `data/contracts/projects/<slug>/` with `info.json` (`name` only) and `logo.webp`. Several contracts share one project. The package build writes `project`, `projectName`, `logoURL`, and `logoHash` onto each published contract, so `getContract` returns them in one lookup.

A contract may keep its own `logo.webp` in `data/contracts/eip155-<id>/<address>/`, next to its JSON. That file wins over the project logo.

```json
{
  "address": "0xabc…",
  "project": "bifrostwallet-com",
  "contractName": "Collateral Pool",
  "category": "fassets"
}
```

`category` is one of the product-approved values below. A new category needs product approval before it is added.

- `dex`: swap routers and AMMs
- `aggregator`: routes swaps across several DEXes
- `bridge`: cross-chain messaging and token transfers
- `lending`: money markets (supply, borrow, liquidation)
- `staking`: delegating or restaking for rewards
- `yield`: vaults and strategies that earn a return on deposits
- `perpetuals`: perpetual futures and leveraged trading
- `predictions`: prediction markets
- `nft-marketplace`: NFT trading venues
- `governance`: voting, DAO and governance contracts
- `fassets`: FAssets system contracts (asset managers, agent vaults, collateral pools)
- `rewards`: protocol-level reward, airdrop and claim managers
- `other`: deliberate rare fallback

Display names are `CONTRACT_CATEGORY_LABELS`. Use that map instead of hardcoding the strings.

Published `logoURL` is the relative path of the logo that won. `logoHash` is the SHA-256 of that WebP. Logos are **128×128** WebP, maximum **24 KB**. A transparent background is recommended so the mark composites on any surface. Opaque WebP, including a solid white background, is valid.

```bash
./yarn check:contracts
```

## Repository layout

```
data/providers/<chain>/<identityAddress>/   info.json, logo.webp, signatures.json, provenance.json
data/providers/<chain>/all.json             generated aggregate (do not edit)
data/tokens/eip155-<id>/…                   curated EVM token metadata + logos
data/tokens/xrpl-0/<issuer>/<currency>/      curated XRPL issued tokens + logos
data/contracts/projects/<slug>/             info.json (name), logo.webp
data/contracts/eip155-<id>/<address>.json   contract record (optional project slug, no all.json)
data/contracts/eip155-<id>/<address>/logo.webp   optional per-contract logo
data/dapps/categories.json                  hand-ordered browser chips (not an all.json)
data/dapps/<slug>/                          info.json, logo.webp (dapp icons, no contact PII, no all.json)
src/                                        curation tooling (TypeScript, dev-only)
```

The listing UI and intake API are operated separately (not in this repository). Contact details stay on private intake objects only.

Per-entry `logoURL` values are **relative** in git and stay relative in the npm package. Provider `all.json` in this repository may contain absolute URLs for bucket upload. That file is an input to the package build, not a public HTTP API.

## Self-serve pipeline

```
provider → listing form (acknowledgements + EIP-712 sign) → verify signature + on-chain entity
        → curated into bifrostwallet/assets → NPM package [+ optional operator CDN]
```

Listings are re-validated in this repository before they go live; CI re-checks ownership signatures on every change.

Operators may upload to their own GCS bucket with `./yarn upload:bucket` and env configuration. That bucket is not a public third-party API.

## Development

### URL verification

Dapp URLs must be confirmed from an official project source: the project's own docs or GitHub org, a verified X account, a flare.network ecosystem link, or the contract deployer docs. Never infer a URL from a name. A dapp `chains` list is confirmed the same way, and only ids in `DAPP_CHAINS` are stored.

Dapp browser chips are hand-edited in `data/dapps/categories.json`. Do not store `category` or `featured` on `info.json`, and do not sort that file. A dapp in no chip fails validation.

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install` to install all dependencies
2. Make your changes
3. Run `./yarn lint && ./yarn test` (use `./yarn lint:fix` to auto-fix) and make sure all tests pass
4. Maintainers push reviewed changes directly to `main`

### Building the package

`./yarn build:package` writes a zero-dependency package to `dist/` (JSON, CommonJS helpers, and TypeScript declarations). Published `logoURL` values stay relative. Logo files are not included. Provider signatures are [`@bifrostwallet/assets/signatures`](#provider-signatures), and the main entry does not load that file. The file npm shows is [`package/README.md`](package/README.md). `ASSET_BASE_URL` rewrites hosted lists during `upload:bucket`. It does not rewrite the npm package. npm releases are staged by [`.github/workflows/release.yml`](.github/workflows/release.yml), as described under [Supply chain security](#supply-chain-security).

## Vulnerability disclosure

Report security vulnerabilities privately per [SECURITY.md](SECURITY.md); **security@bifrostwallet.com** (OpenPGP preferred). Do not open public issues for security reports.

## License

MIT. Copyright (c) 2026 Bifrost Software Ltd. See [LICENSE](LICENSE).
