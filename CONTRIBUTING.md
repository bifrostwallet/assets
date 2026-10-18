# Contributing

This repository is maintained by Bifrost Wallet curators. Listing and tooling
changes are applied by maintainers on `main`; do not open pull requests for
catalog data.

## Provider and dapp data: use the listing forms

All listing data is verified and curated into this repository. Hand-edited data
PRs bypass those guarantees and are **closed without review**.

- **Add or update your provider listing:** use the listing form on
  [bifrostwallet.com/list/provider](https://bifrostwallet.com/list/provider).
- **Add or update your dapp listing:** use the listing form on
  [bifrostwallet.com/list/dapp](https://bifrostwallet.com/list/dapp).

## URL verification

Dapp URLs must be confirmed from an official project source: the project's own docs or GitHub org, a verified X account, a flare.network ecosystem link, or the contract deployer docs. Never infer a URL from a name. A dapp `chains` list is confirmed the same way, and only ids in `DAPP_CHAINS` are stored.

## Dapp categories

Browser chips and the not-browsable list are the hand-edited `data/dapps/categories.json`: `categories` is the ordered chips, and `unlisted` is an explicit list of dapps that contracts may reference but the browser must not show. Place a dapp from its official site. Never sort the file, never infer a chip, and never add network filters. `marketplaces` is NFT marketplaces only. A dapp that matches no chip goes in `unlisted`. Validation fails if a dapp is in neither a chip nor `unlisted`, or in both.

## Code and documentation

Bug reports and suggestions are welcome as issues. For anything beyond a
trivial fix, please open an issue first so we can confirm the direction.
