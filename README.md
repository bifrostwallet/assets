# Assets

Bifrost Wallet maintains curated providers, tokens, dapps and contracts to enrich the user experience of our self-custody multi-chain wallet and various applications in the Flare/Songbird ecosystems. The purpose of curating this data is to map on-chain addresses to logos and other off-chain data.

This repository is the single source of truth. It publishes primarily as:

- **NPM package** [`@bifrostwallet/assets`](#npm-package): zero-dependency JSON data plus lookup helpers; logos resolve to **GitHub raw** by default

**Using the package:** see [CONSUMERS.md](CONSUMERS.md) and the full guide on [docs.bifrostwallet.com](https://docs.bifrostwallet.com/list/consuming-assets). Operators may optionally upload to their **own** GCS/CDN via env; that path is not a public third-party API.

## FTSO Data Providers

One listing covers your **provider identity** and nested **validator NodeIDs**. Validators are not a separate listing type.

### Adding your provider (self-serve)

Use the listing form on bifrostwallet.com; no GitHub account or repository interaction required. Submissions are reviewed by curators and not guaranteed a listing.

1. Open [bifrostwallet.com/list/provider](https://bifrostwallet.com/list/provider)
2. Connect the wallet holding your identity address (or paste the address); entity data is fetched from the EntityManager and the network is detected automatically
3. Fill in name, description, website, social links and upload a logo ([image requirements](#logo-requirements))
4. Confirm the [listing acknowledgement](#listing-acknowledgement) (required checkbox)
5. Sign EIP-712 typed data with the wallet holding your **identity address**
6. Submit: your listing is verified and curated into [`bifrostwallet/assets`](https://github.com/bifrostwallet/assets), and goes live once reviewed

Submissions are accepted only when signed by the identity address itself and when that address is a registered entity on-chain. Submitting again updates your pending submission. To change your listing later, go through the app again.

### Ownership signatures

Every provider entry carries a `signatures.json` proving control of the identity address. Signatures use **EIP-712** (`eth_signTypedData_v4`, domain `Bifrost Assets`). The signed payload is `name`, `description`, `websiteURL`, `links`, `identityAddress`, `acknowledgedResponsibilities`, and `logoHash`. It excludes:

- `logoURL` is a hosting detail; logo integrity is covered by the signed `logoHash`
- `listed` is granted by curators (see [listed in Bifrost Wallet](#listed-in-bifrost-wallet))
- `managementGroup` is synced from that network's on-chain PollingManagementGroup (Flare and Songbird each have their own group)
- `domainLinked` is refreshed nightly from optional website well-known / DNS linkage
- `dualNetwork` marks the same brand present on both Flare and Songbird (kept current by `sync:dual-network`)
- `firstTransaction` records the earliest known on-chain activity
- `delegationAddress`, `signingPolicyAddress`, `submitAddress`, `submitSignaturesAddress`, `publicKey`, and `validators` are the on-chain snapshot, including validator NodeIDs. A nightly job may update them without a new signature

CI verifies all signatures cryptographically (`yarn verify:providers`). A change to your name, description, website, links, acknowledgement, or logo requires a new signature. Chain addresses, the public key, and validators can change without one.

The signature requirement is a **self-signature** by the entry's identity address.

**Deadline:** entries that predate the public launch of this repository are grandfathered until **1 November 2026**. After that date, entries without a valid self-signature are delisted (`listed: false`) until signed.

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
- **Domain linkage** (same payload for file and DNS; see below). Nightly refresh always checks both methods and sets unsigned `domainLinked` when at least one matches and the two do not contradict for this identity.

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

### Listed in Bifrost Wallet

To be **Listed in Bifrost Wallet**, curators require **private outreach on file** (submitted via the listing portal; end-to-end encrypted in the browser and encrypted at rest, not published here) **and** `domainLinked: true`, in addition to the Trustworthy / Resilient / Independent / Available bar above. Domain linkage and outreach are not self-granted on intake.

**Initial listing guidelines** (curator bar for new `listed: true`; not auto-applied by CI):

| Network | Guideline |
| --- | --- |
| **Flare** | Self-bond ≥ **10M FLR**; ≥ **2** validators; ≥ **20** unique P-chain stakers **and** ≥ **2M FLR** external stake; WFLR vote power ≥ **100M FLR**; prefer brands that already have a Songbird (canary) catalog entry |
| **Songbird** | WSGB vote power ≥ **50M** |

**Grandfathering:** providers that were listed before this repository went public keep `listed: true` until **1 November 2026** without meeting the domain linkage and ownership signature requirements. From that date, listed providers that have not completed domain linkage and do not carry a valid self-signature are delisted. Delisted providers are relisted once they meet the requirements again.

### Recommendations for developers

If you're a wallet or dapp developer using our curated provider data:

1. **Hide** providers with `listed: false` from picker / discovery UIs.
2. **Show** all providers in contexts where a choice has already been made (confirmations, transaction details).

NPM install and examples: [CONSUMERS.md](CONSUMERS.md). Full integrator guide: [docs.bifrostwallet.com](https://docs.bifrostwallet.com/list/consuming-assets).

## Dapps

Self-serve dapp bookmarks via [bifrostwallet.com/list/dapp](https://bifrostwallet.com/list/dapp). Contact details are sealed privately; public fields are title, description, URL, chains, category, and logo. Listing guide: [docs.bifrostwallet.com: Dapp](https://docs.bifrostwallet.com/list/dapp).

## Tokens

Token metadata is curated by Bifrost Wallet (not self-serve). Catalog lives under `data/tokens/eip155-<id>/<address|native>/` with `info.json` + `logo.webp`, per-chain `all.json`, and `data/tokens/blocklist.json`. The native gas token uses `address: null` and directory `native/` (no separate `native` boolean).

Every `info.json` **must** include `coingeckoId` (`string` or `null`). CoinGecko is only for id resolution / optional price hints, never for growing the list or overriding on-chain name/symbol/decimals.

```bash
./yarn check:tokens -- --skip-onchain
```

## Contracts

Contract names are shown in Bifrost Wallet transaction-review modals. The wallet checks the user's address book first. This catalog is the fallback that turns a hex address into a readable name such as `Bifrost Wallet: Collateral Pool`.

Entries live at `data/contracts/eip155-<id>/<lowercase-address>/info.json` (path-safe CAIP-2, same folder layout as tokens and providers). The chain directory is the chain: `eip155-14` is CAIP-2 `eip155:14`. The address directory name is the address. Do not store `chain` in `info.json`. There is no aggregate `all.json`. `getContract` / `getContracts` read these files, include `chain`, and resolve `logoURL` plus `logoHash`. The published package bundles those same lists at build time. There is no `listed` flag and no provider link. Token contracts live in `tokens/`, not `contracts/`.

The logo belongs to the project, not to each contract. `data/projects/<slug>/info.json` holds the display name and exactly one `logo.webp` (`logoURL` + `logoHash`). Each contract stores `project` (the slug) instead of repeating the mark. A contract may set its own `logo.webp` plus `logoURL` and `logoHash` only when that contract needs a different mark; otherwise it inherits the project logo.

```json
{
  "address": "0xabc…",
  "project": "bifrost-wallet",
  "contractName": "Collateral Pool",
  "category": "fassets"
}
```

```json
{
  "name": "Bifrost Wallet",
  "logoURL": "projects/bifrost-wallet/logo.webp",
  "logoHash": "…"
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

Resolved `logoURL` is a relative WebP path in git and an absolute URL in the published package. `logoHash` is the SHA-256 of that file. Project logos are small transparent lossless **128×128** WebP, maximum **24 KB**, one file per project.

```bash
./yarn check:contracts
```

## Repository layout

```
data/providers/<chain>/<identityAddress>/   info.json, logo.webp, signatures.json, provenance.json
data/providers/<chain>/all.json             generated aggregate (do not edit)
data/tokens/eip155-<id>/…                   curated token metadata + logos
data/contracts/eip155-<id>/<address>/info.json   contract display names (no all.json)
data/projects/<slug>/                          project name + one shared logo.webp
data/dapps/<slug>/                          curated dapp bookmarks (no contact PII)
src/                                        curation tooling (TypeScript, dev-only)
```

The listing UI and intake API are operated separately (not in this repository). Contact details stay on private intake objects only.

Asset paths (e.g. `logoURL`) are **relative** in git; the published NPM package uses absolute GitHub raw URLs by default.

## Self-serve pipeline

```
provider → listing form (acknowledgements + EIP-712 sign) → verify signature + on-chain entity
        → curated into bifrostwallet/assets → NPM package [+ optional operator CDN]
```

Listings are re-validated in this repository before they go live; CI re-checks ownership signatures on every change.

## NPM package

`./yarn build:package` produces a **zero-dependency** package in `dist/` (lists, types, helpers). The published README is [`package/README.md`](package/README.md). Publish with `npm publish ./dist`. Logos in the package are absolute GitHub raw URLs unless you set `ASSET_BASE_URL` at build time.

## Development

Use the repo [`yarn`](yarn) wrapper (`./yarn`), not Corepack or a global install.
CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install` to install all dependencies
2. Make your changes
3. Run `./yarn lint && ./yarn test` (use `./yarn lint:fix` to auto-fix) and make sure all tests pass
4. Maintainers push reviewed changes directly to `main`

## Vulnerability disclosure

Report security vulnerabilities privately per [SECURITY.md](SECURITY.md); **security@bifrostwallet.com** (OpenPGP preferred). Do not open public issues for security reports.
