# CLAUDE.md

Public catalog of providers, validators, tokens, contracts, and dapps for Bifrost Wallet. Read [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before editing data or tooling.

## Tooling

- Node is pinned at 24.22.3 in `.node-version` and `.nvmrc`. Run commands with `./yarn` (Yarn 4.18.1). Do not use Corepack or a global Yarn.
- Yarn and hook pins stay intact: the `packageManager` checksum, `.yarn/releases`, `yarn.lock`, `.yarnrc.yml`, the committed PnP files, and `.git-hooks`. Do not add a dependency, another package manager, or another hook installer. `enableScripts` stays false. Do not hand-edit `.yarn/cache` archives or `package-attestations.json`.
- Biome and TypeScript stay clean. Run `./yarn lint` and `./yarn typecheck`. ShellCheck and yamllint stay clean too (`./yarn lint:shell`, `./yarn lint:yaml`). Tests are `./yarn test`. Scripts are POSIX `sh`.
- Do not commit `.env` files or outreach data. `./yarn verify:no-contact-pii` must pass.

## Listings

Hand-edited catalog pull requests are closed. Providers and validators are submitted through the listing form on bifrostwallet.com. Tokens, contracts, and dapps are curated by maintainers. Use this repository's scripts:

- `./yarn add:token <chain> <address>` reads that token's name, symbol, and decimals from the chain RPC
- `./yarn add:provider` and `./yarn add:dapp`
- `./yarn remove:provider` and `./yarn remove:dapp`
- `./yarn check:tokens`, `check:providers`, `check:dapps`, and `check:contracts`
- `./yarn verify:providers` and `./yarn verify:provider-domains`

For a code change beyond a small fix, open an issue first. Maintainers apply tooling changes on `main`.

## Logos and CoinGecko

Never edit a signed provider `logo.webp`. `logoHash` is the SHA-256 of those bytes and is part of the EIP-712 `ProviderListing` signature. Changing a signed field, including the logo, needs a new signature from the identity address. Logos are 128×128 WebP, at most 24 KB. Curator fields such as `listed` sit outside the signature. CI does not change `listed`.

CoinGecko ids are added here. Every token `info.json` includes `coingeckoId` (`string` or `null`). `./yarn add:token` records the id. On-chain name, symbol, and decimals stay as curated. Do not point logo URLs at raw GitHub file hosts. The package uses jsDelivr for a release tag, or a caller-supplied `baseURL`.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
