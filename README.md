# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

Chain ids in the public API are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md): `eip155:14` (Flare), `eip155:19` (Songbird), and `xrpl:0` (XRPL). Directory names use a hyphen (`eip155-14`) because they are file paths. Function arguments use a colon (`eip155:14`).

Providers submit a listing with the form below. Integrators install the package and read providers and validators from it. Hosting logos and optional checks are in [CONSUMERS.md](CONSUMERS.md).

## For providers

One listing covers your provider identity and the validator NodeIDs that belong to it.

### Get listed

Submit through the listing form on bifrostwallet.com. Curators review each submission before it is listed.

1. Open [bifrostwallet.com/list/provider](https://bifrostwallet.com/list/provider).
2. Connect the wallet that holds your identity address, or paste the address. Entity data is read from the EntityManager, and the network is detected from that address.
3. Fill in the name, description, website, and social links, and upload a logo ([Logo requirements](#logo-requirements)).
4. Confirm the listing acknowledgement. The checkbox is required.
5. Sign the EIP-712 `ProviderListing` typed data with the wallet that holds your identity address. The signed fields are under [Ownership signatures](#ownership-signatures).
6. Submit. The listing is checked and curated into [`bifrostwallet/assets`](https://github.com/bifrostwallet/assets), and it goes live once a curator has reviewed it.

Submissions are accepted only when signed by the identity address itself and when that address is a registered entity on-chain. Submitting again updates your pending submission. To change your listing later, submit the listing form again.

### Logo requirements

Provide a PNG or WebP of at least 128×128. Larger images are fine. The listing form cover-fits the image and converts it to the catalog form before you hash and sign.

- 128×128 WebP. A transparent background lets the mark sit on any surface. Opaque WebP, including a solid white background, is valid.
- Maximum file size 24 KB.
- Stored as `logo.webp`. `logoHash` is the SHA-256 of those WebP bytes.

A new submission that is not exactly this WebP form is rejected. Catalog images in this repository are WebP.

### Listing requirements

#### Trustworthy

The team that develops and runs the provider is known to other providers.

#### Domain linkage

Publish the same allowlisted payload on your site, in DNS, or in both places. Both places are checked. The catalog records `domainLinked` when at least one copy matches this identity and the two copies do not contradict. Curators record domain linkage after that check.

#### Domain linkage format

The payload is one or more `eip155:<chainId>:<identity>` entries, separated by commas.

| Where | What |
| --- | --- |
| HTTPS file | `https://<your-site>/.well-known/providers.txt` |
| DNS TXT | Name `_providers.<your-site>` |

```bash
curl -sS https://example.com/.well-known/providers.txt
# eip155:14:0x…,eip155:19:0x…

dig +short TXT _providers.example.com
# "eip155:14:0x…,eip155:19:0x…"
```

Check a curated identity with `./yarn verify:provider-domains --identity 0x…`. The walkthrough is on [docs.bifrostwallet.com](https://docs.bifrostwallet.com/) (FTSO provider listing).

#### Resilient

A team keeps at most one vote-power-attracting FTSO/FSP identity on each network. Protocol submissions use infrastructure the team controls. A shared public RPC used by other providers does not meet this requirement. The listing form asks you to confirm this before you sign.

#### Independent

On a network, the provider runs on its own and keeps its own infrastructure, separate from other FTSO/FSP providers. That stack is its own FDC, FSP, feed provider, validators, and RPC node, under a single identity for that network. The listing form asks you to confirm this before you sign. The signed field is `acknowledgedResponsibilities`.

#### Available

A listed provider stays operationally active. It submits and earns FSP rewards with healthy uptime, and it runs the stack that makes that possible (FDC, FSP, feed provider, validators, and an RPC node), with enough self-bond, vote power, and stake to participate meaningfully.

Participation is judged from Flare Systems Protocol data ([fsp-rewards](https://github.com/flare-foundation/fsp-rewards)), not from self-attested uptime.

Providers whose FSP rewards are burned are delisted. Curators may also delist a provider that keeps failing the advisory eligibility screen (`./yarn check:providers`). That provider can be listed again when it is healthy. An operator whose current FTSO/FSP delegation fee, or any currently validating Flare validator fee, is above 50% is delisted under [Delegation fees](#delegation-fees).

#### Delegation fees

This cap is Bifrost's own listing recommendation. It is not a Flare or Songbird protocol rule. The protocols allow a higher delegation fee.

An operator remains `listed: true` when both of these hold:

- The current FTSO/FSP delegation fee is 50% or lower. A fee strictly above 50% is delisted. Exactly 50% may stay listed.
- On Flare, every validator that is currently validating charges 50% or lower. One validator above the cap delists the whole operator. Validators that are not currently validating are left out of this check. Songbird has no P-chain staking, so only the FTSO/FSP fee applies there.

20% is the usual fee. A fee below 20% may stay listed. There is no lower bound.

#### Listed in Bifrost Wallet

To be listed in Bifrost Wallet, curators need private outreach on file and `domainLinked: true`, together with the trustworthy, resilient, independent, and available requirements above. Outreach is submitted through the listing form, encrypted in the browser and encrypted at rest, and it stays out of this repository. Curators record domain linkage and outreach after they have checked them.

#### Initial listing guidelines

Curators use this bar when they set a new provider to `listed: true`. CI leaves that flag unchanged.

| Network | Guideline |
| --- | --- |
| Flare | Self-bond at least 10M FLR; at least 2 validators; at least 20 unique P-chain stakers and at least 2M FLR of external stake; WFLR vote power at least 100M FLR. Brands that already have a Songbird (canary) catalog entry are preferred. |
| Songbird | WSGB vote power at least 50M. |

#### Grandfathering

Providers that were listed before this repository went public keep `listed: true` until 31 December 2026 without the domain linkage and ownership signature requirements. After 31 December 2026, a listed provider without a self-signature and `domainLinked: true` is set to `listed: false`. A delisted provider is listed again once it meets the requirements.

## For integrators

Pin one version and commit the lockfile, then read listed providers and validators from the package. Self-hosted logos are the standard path. GitHub raw `all.json` remains for readers that skip the package.

### Install

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

pnpm uses `--save-exact`. Yarn uses `--exact`. The same lines are in [package/README.md](package/README.md).

An unknown chain id throws. A missing provider returns `null`. `PROVIDER_CHAIN_IDS` is `eip155:14` and `eip155:19`.

### Listed providers

Picker and discovery views use providers with `listed: true`. A confirmation or a transaction detail still shows a provider the user already chose, including one that is not listed.

```typescript
import { getListedProviders, getProvider, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));

// This identity is Bifrost Wallet. null when this version has no such record.
const provider = getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
```

`getListedProviders(chainId)` returns providers with `listed: true`. `getProviders(chainId)` returns every provider on that chain. `getProvider(chainId, identityAddress)` returns one provider, or `null`, and the address match ignores case. `getManagementGroupProviders(chainId)` returns providers with `managementGroup: true`.

### Listed validators

`getListedValidators(chainId)` returns one entry per NodeID for providers with `listed: true`, in that provider order. Each entry has `nodeId`, `identityAddress`, and `name`. `getValidators(chainId)` returns every validator on the chain, including validators of providers that are not listed.

```typescript
import { getListedValidators } from "@bifrostwallet/assets";

const validators = getListedValidators("eip155:14");
```

### Validators for one identity

`getValidatorsByIdentity(chainId, identityAddress)` returns that provider's validators. The address match ignores case, and a missing identity returns an empty array. `findProviderByValidator(chainId, nodeId)` returns the provider that operates that NodeID, or `null`. The NodeID includes the `NodeID-` prefix.

```typescript
import {
  findProviderByValidator,
  getValidatorsByIdentity,
} from "@bifrostwallet/assets";

const own = getValidatorsByIdentity(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
const provider = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
```

### Logos

Host the `logo.webp` files yourself. The npm package ships the catalog records. Check out the tag `v` plus the package version, copy logos from `data/providers`, `data/tokens`, `data/dapps`, and `data/contracts`, and pass that host to `resolveAssetURL`. Copy commands are in [CONSUMERS.md](CONSUMERS.md).

#### Logo URLs

In git, each entry's `info.json` stores a relative `logoURL`. Provider and token `all.json` files in git use absolute GitHub raw logo URLs. `logoURL` values in the npm package are relative: the build rewrites `all.json` back to relative paths. `upload:bucket` rebases a hosted `all.json` onto `ASSET_BASE_URL`.

`resolveAssetURL(logoURL, baseURL?)` joins a package `logoURL` to your base. The base is the directory that contains `providers/`, `tokens/`, `dapps/`, and `contracts/`. The same call works for a provider, token, dapp, or contract. Pass your own base when you host the files. When the base is omitted or blank, logos load from GitHub at the tag for the installed version (`GITHUB_ASSET_BASE_URL`). `DEFAULT_ASSET_BASE_URL` is a deprecated alias of that prefix. An absolute `logoURL` whose path contains `providers/`, `tokens/`, `dapps/`, or `contracts/` is reduced to that relative path and joined to your base.

### Without the package

Fetch GitHub raw `all.json` when you are not installing the package. See [Logo URLs](#logo-urls).

1. Fetch `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/<chain>/all.json`. The chain directory uses a hyphen, such as `eip155-14`.
2. For listed providers, keep records with `listed: true` and use `logoURL` as published.
3. For listed validator NodeIDs, read `validators` on those records.

```js
const response = await fetch(
  "https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-14/all.json",
);
const providers = await response.json();
const listed = providers.filter((provider) => provider.listed);
const logoURL = listed[0]?.logoURL;
const nodeIds = listed.flatMap((provider) => provider.validators);
```

Operator signatures ship from `@bifrostwallet/assets/signatures`, so a normal import does not download them. `getProviderSignatures(chainId, identityAddress)` returns the record, or `null` when this version has no signature file for that identity. Some listings stay unsigned until 31 December 2026. Recovering the signer is described in [CONSUMERS.md](CONSUMERS.md). The signed fields are under [Ownership signatures](#ownership-signatures).

## Ownership signatures

Every provider entry carries a `signatures.json` proving control of the identity address. The requirement is a self-signature by that address: EIP-712 (`eth_signTypedData_v4`) over `ProviderListing`.

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

Changing any of these fields needs a new signature. Fields outside this list are unsigned and can change without a new signature, including on-chain data refreshed on a schedule.

CI checks every signature with `./yarn verify:providers`. Listings are checked again in this repository before they go live. Entries that predate the public launch stay listed through the date in [Grandfathering](#grandfathering).

## Supply chain security

### Releases

[`.github/workflows/release.yml`](.github/workflows/release.yml) stages `@bifrostwallet/assets` with npm Trusted Publishing (OIDC, `id-token: write`). The publish step sets `NPM_CONFIG_PROVENANCE=true` and runs `npm stage publish ./dist --access public --tag beta`. A GitHub Release whose tag is `v` plus the package version triggers it, as does a manual run with `publish=true`. A manual run with `publish=false` only builds `dist/`. A maintainer approves the staged version on npmjs.com before it is installable. The workflow refuses a version that is not `alpha`, `beta`, or `rc` until provider signature checks are strict. Confirm the green check on the npm version page. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/).

### Package manifest

`dist/package.json` is written with `"dependencies": {}`. The build fails if that manifest declares `dependencies`, `devDependencies`, or `peerDependencies`.

### Dev dependencies

Dev dependencies are pinned to exact versions and are left out of `dist/package.json`, so an install of the published package does not install them. They are used for curation, lint, and the package build:

- `@biomejs/biome` — lint and format
- `@google-cloud/storage` — maintainer bucket upload
- `@types/node` — Node types for the TypeScript build
- `bs58` — base58 checks in curation scripts (NodeIDs and XRPL addresses)
- `typescript` — compile and typecheck
- `viem` — chain reads and EIP-712 recovery in curation scripts

Report vulnerabilities privately to **security@bifrostwallet.com**. See [SECURITY.md](SECURITY.md).

## Building the package

`./yarn build:package` writes the package to `dist/`. Logo files are left out, provider signatures stay on `@bifrostwallet/assets/signatures` so the main entry does not load them, and the file npm shows is [`package/README.md`](package/README.md).

Releases are staged as described under [Supply chain security](#supply-chain-security).

## Tokens

Token metadata is curated by Bifrost Wallet. EVM catalogs live under `data/tokens/eip155-<id>/<address|native>/` with `info.json` and `logo.webp`, and a per-chain `all.json`. The native gas token uses `address: null` and the directory `native/`, with no separate `native` boolean. Logo URL shape is described under [Logo URLs](#logo-urls).

XRPL mainnet issued tokens live under `data/tokens/xrpl-0/<issuer>/<currency>/`. `issuer` is the classic r-address in exact case. `currency` is the on-ledger code: a 3-character code in exact case, or 40-hex uppercase. There is no `address` field. Lookup is `getXrplToken(issuer, currency)` and keeps that exact case. EVM lookup is `getToken(chain, address)`. `symbol` is the decoded currency. XRPL tokens carry no decimals. AMM LP tokens (40-hex currency codes starting with `03`) are left unlisted.

Every `info.json` includes `coingeckoId` (`string` or `null`). CoinGecko is used for id resolution and optional price hints. The catalog list, and on-chain name, symbol, and decimals, stay as curated.

`getToken` looks up EVM contracts. The native gas token is `getNativeToken`. Lookup chain ids stay CAIP-2.

```typescript
import {
  getNativeToken,
  getToken,
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

if (wflr) {
  const logoURL = resolveAssetURL(wflr.logoURL, base);
  console.log(flare?.symbol, wflr.symbol, issued?.name, logoURL);
}
console.log(flareTokens.length);
```

`getXrplToken("rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", "eth")` returns `null` because the currency case differs.

Curators add one EVM token with the chain directory and the contract address:

```bash
./yarn add:token eip155-1 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
```

The command reads that token's name, symbol, and decimals from the chain's `*_NODE_URL`. It trims both strings, keeps internal spaces, and refuses an empty value, a bytes32 `name()` or `symbol()`, a symbol containing `.`, or a symbol already used on that chain. The logo comes from CoinGecko, then [Trust Wallet's assets repository](https://github.com/trustwallet/assets), and is stored as 128×128 WebP at most 24 KB (`cwebp` from libwebp, same as dapp logos). It writes `info.json` and `logo.webp` for that address only, rebuilds that chain's `all.json`, and leaves the rest of the catalog unread on-chain.

```bash
./yarn check:tokens -- --skip-onchain
```

`./yarn check:tokens` rejects a new duplicate EVM symbol. Symbols that were already duplicated stay allowed.

## Contracts

Contract names are shown in Bifrost Wallet transaction-review modals. The wallet checks the user's address book first. This catalog is the fallback that turns a hex address into a readable name such as `Bifrost Wallet: Collateral Pool`.

Entries live at `data/contracts/eip155-<id>/<lowercase-address>.json` (path-safe CAIP-2). The directory is the chain: `eip155-14` is CAIP-2 `eip155:14`. The filename is the address. The file stores `address`, `contractName`, `category`, and an optional `project` slug. It leaves out `chain`, `dapp`, `projectName`, `logoURL`, and `logoHash`. Contracts have no aggregate `all.json`, no `listed` flag, and no provider link. Token contracts live in `tokens/`.

`project` names a folder `data/contracts/projects/<slug>/` with `info.json` (`name` only) and `logo.webp`. Several contracts can share one project. The package build adds `project`, `projectName`, `logoURL`, and `logoHash` to each published contract, so `getContract` returns them in one lookup. `projectName` is the project `name`. `category` is a `CONTRACT_CATEGORIES` id. Display the label from `CONTRACT_CATEGORY_LABELS`.

A contract may keep its own `logo.webp` in `data/contracts/eip155-<id>/<address>/`, next to its JSON. That file wins over the project logo. The package sets `logoURL` to the file that won, and `logoHash` to the SHA-256 of that WebP. Logos are 128×128 WebP, maximum 24 KB. A transparent background lets the mark sit on any surface. Opaque WebP, including a solid white background, is valid.

```json
{
  "address": "0xabc…",
  "project": "bifrostwallet-com",
  "contractName": "Collateral Pool",
  "category": "fassets"
}
```

`category` is one of the values below. A new category needs product approval before it is added.

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

```bash
./yarn check:contracts
```

## Dapps

A dapp is submitted through [bifrostwallet.com/list/dapp](https://bifrostwallet.com/list/dapp). Contact details stay private. The public fields are title, description, URL, chains, and logo. The listing guide is [docs.bifrostwallet.com: Dapp](https://docs.bifrostwallet.com/list/dapp).

Each dapp lives at `data/dapps/<slug>/` with `info.json` and one `logo.webp`. `logoHash` is the SHA-256 of that file. `title` is the display name. Dapps have no per-entry category or featured flag, and they have no `all.json`. The package reads browser chips with `getDappCategories()`. URL checks and chip rules are under [Development](#development).

```typescript
import { DAPP_CATEGORY_LABELS, getDappCategories } from "@bifrostwallet/assets";

const chips = getDappCategories();
const dex = chips.find((chip) => chip.id === "dex");
const dexLabel = DAPP_CATEGORY_LABELS.dex; // "DEX"
console.log(dexLabel, dex?.dapps);
```

## Development

### Dapp URLs

Dapp URLs come from an official project source: the project's own docs or GitHub org, a verified X account, a flare.network ecosystem link, or the contract deployer docs. A name on its own is not a source. A dapp `chains` list is confirmed the same way, and only ids in `DAPP_CHAINS` are stored.

### Dapp categories

Browser chips are hand-edited in `data/dapps/categories.json`, an ordered array of `{ id, label, dapps }`. The order is `featured`, `dex`, `lending`, `yield`, `staking`, `bridges`, `marketplaces`, `social`, `games`, `other`. Order inside a chip is curated. A dapp may appear in more than one chip. Every dapp folder appears in at least one chip. `bridges` is cross-chain token and message transfer. `marketplaces` is NFT marketplaces only. `other` is the fallback chip. `info.json` carries neither `category` nor `featured`. The chip file is kept in that curated order. `./yarn check:contracts` fails when a dapp folder is missing from the chips. `./yarn check:dapps` warns in that case and still exits 0.

```bash
./yarn check:dapps
```

`./yarn check:dapps` fails when an `info.json` breaks the schema (title, description, https URL, `logoURL`, `logoHash`, allowed CAIP-2 chains), when `logo.webp` is missing, not WebP, the wrong size, or a different hash, and when `categories.json` names a missing slug, repeats a slug inside one chip, or uses a category id outside `DAPP_CATEGORIES`.

### Catalog refresh

The nightly refresh checks both domain-linkage methods and sets unsigned `domainLinked` when at least one matches and the two do not contradict for this identity. It reads the FTSO fee from `WNatDelegationFee.getVoterCurrentFeePercentage` (basis points, through `FlareContractRegistry`) and Flare validator fees from `platform.getCurrentValidators`. A Flare validator counts as currently validating when its NodeID is still returned for that provider. Providers whose FSP rewards are burned (`eligibleForReward: false` in the latest `passes.json`), operators over the delegation-fee cap, and chain-drift updates are proposed together on the `nightly/fsp-delist` pull request. A curator merges that pull request. `./yarn check:providers` prints the fee check as an advisory and does not fail on it.

### Working in this repository

The listing form and intake API run outside this repository. Contact details stay on private intake objects.

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install` to install dependencies.
2. Make your changes.
3. Run `./yarn lint && ./yarn test` (`./yarn lint:fix` applies the automatic fixes) and keep the tests passing.
4. Maintainers push reviewed changes directly to `main`.

## Vulnerability disclosure

Report security vulnerabilities privately per [SECURITY.md](SECURITY.md), to **security@bifrostwallet.com** (OpenPGP preferred). Public issues are for other reports.
