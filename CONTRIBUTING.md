# Contributing

Catalog listings go through the forms below. Curators review each submission before it is listed. Hand-edited catalog pull requests are closed without review. Maintainers apply tooling changes on `main`. For a code change beyond a small fix, open an issue first.

## Providers

One listing covers your provider identity and the validator NodeIDs that belong to it.

### Get listed

Submit through the listing form on bifrostwallet.com.

1. Open [bifrostwallet.com/list/provider](https://bifrostwallet.com/list/provider).
2. Connect the wallet that holds your identity address, or paste the address. Entity data is read from the EntityManager, and the network is detected from that address.
3. Fill in the name, description, website, and social links, and upload a logo ([Logo requirements](#logo-requirements)).
4. Confirm the listing acknowledgement. The checkbox is required.
5. Sign the EIP-712 `ProviderListing` typed data with the wallet that holds your identity address. The signed fields are under [Signatures](README.md#signatures).
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

Check a curated identity with `./yarn verify:provider-domains --identity 0x…`. The walkthrough is on [docs.bifrostwallet.com](https://docs.bifrostwallet.com/) ([FTSO](README.md#glossary) provider listing).

#### Resilient

A team keeps at most one vote-power-attracting FTSO/[FSP](README.md#glossary) identity on each network. Protocol submissions use infrastructure the team controls. A shared public RPC used by other providers does not meet this requirement. The listing form asks you to confirm this before you sign.

#### Independent

On a network, the provider runs on its own and keeps its own infrastructure, separate from other FTSO/FSP providers. That stack is its own [FDC](README.md#glossary), FSP, feed provider, validators, and RPC node, under a single identity for that network. The listing form asks you to confirm this before you sign. The signed field is `acknowledgedResponsibilities`.

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

## Tokens

Token metadata is curated by Bifrost Wallet. Package lookups are in [Using the package](README.md#using-the-package).

EVM catalogs live under `data/tokens/eip155-<id>/<address|native>/` with `info.json` and `logo.webp`. The native gas token uses `address: null` and the directory `native/`, with no separate `native` boolean.

XRPL mainnet issued tokens live under `data/tokens/xrpl-0/<issuer>/<currency>/`. `issuer` is the classic r-address in exact case. `currency` is the on-ledger code: a 3-character code in exact case, or 40-hex uppercase. Lookup uses issuer and currency, and keeps that exact case. `symbol` is the decoded currency. XRPL tokens carry no decimals. AMM LP tokens (40-hex currency codes starting with `03`) are left unlisted.

Every `info.json` includes `coingeckoId` (`string` or `null`). CoinGecko is used for id resolution and optional price hints. The catalog list, and on-chain name, symbol, and decimals, stay as curated.

Curators add one EVM token with the chain directory and the contract address:

```bash
./yarn add:token eip155-1 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
```

The command reads that token's name, symbol, and decimals from the chain's `*_NODE_URL`. It trims both strings, keeps internal spaces and `.`, and refuses an empty value, a bytes32 `name()` or `symbol()`, or a symbol already used on that chain. The logo comes from CoinGecko and is stored as 128×128 WebP at most 24 KB (`cwebp` from libwebp, same as dapp logos). It writes `info.json` and `logo.webp` for that address only, and leaves the rest of the catalog unread on-chain.

```bash
./yarn check:tokens -- --skip-onchain
```

`./yarn check:tokens` rejects a new duplicate EVM symbol. Symbols that were already duplicated stay allowed.

## Dapps

A dapp is submitted through [bifrostwallet.com/list/dapp](https://bifrostwallet.com/list/dapp). Contact details stay private. The public fields are title, description, URL, chains, and logo. The listing guide is [docs.bifrostwallet.com: Dapp](https://docs.bifrostwallet.com/list/dapp).

Each dapp lives at `data/dapps/<slug>/` with `info.json` and one `logo.webp`. `logoHash` is the SHA-256 of that file. `title` is the display name. Dapps have no per-entry category or featured flag, and they have no `all.json`. The package reads browser chips with `assets.getDappCategories()`.

### Dapp URLs

Dapp URLs come from an official project source: the project's own docs or GitHub org, a verified X account, a flare.network ecosystem link, or the contract deployer docs. A name on its own is not a source. A dapp `chains` list is confirmed the same way, and only ids in `DAPP_CHAINS` are stored.

### Dapp categories

Browser chips are hand-edited in `data/dapps/categories.json`, an ordered array of `{ id, label, dapps }`. The order is `featured`, `dex`, `lending`, `yield`, `staking`, `bridges`, `marketplaces`, `social`, `games`, `other`. Order inside a chip is curated. A dapp may appear in more than one chip. Every dapp folder appears in at least one chip. `bridges` is cross-chain token and message transfer. `marketplaces` is NFT marketplaces only. `other` is the fallback chip. `info.json` carries neither `category` nor `featured`. The chip file is kept in that curated order. `./yarn check:contracts` fails when a dapp folder is missing from the chips. `./yarn check:dapps` warns in that case and still exits 0.

```bash
./yarn check:dapps
```

`./yarn check:dapps` fails when an `info.json` breaks the schema (title, description, https URL, `logoURL`, `logoHash`, allowed CAIP-2 chains), when `logo.webp` is missing, not WebP, the wrong size, or a different hash, and when `categories.json` names a missing slug, repeats a slug inside one chip, or uses a category id outside `DAPP_CATEGORIES`.

## Contracts

Contract names are shown in Bifrost Wallet transaction-review modals. This catalog is the fallback that turns a hex address into a readable name such as `Bifrost Wallet: Collateral Pool`. Package lookups are in [Using the package](README.md#other-lookups).

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

```bash
./yarn check:contracts
```
