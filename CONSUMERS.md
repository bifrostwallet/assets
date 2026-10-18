# Consuming assets

Install [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets). The package README on npm has install and quick-start examples (Bifrost Wallet’s Flare provider, validator, and WNAT).

**Full integrator guide:** [docs.bifrostwallet.com: Consuming Assets](https://docs.bifrostwallet.com/list/consuming-assets)

For listing rules (providers, dapps, contract names, logos), see [README.md](README.md). Contract lookup is `getContract(chain, address)` / `getContracts(chain?)`. `projectName` is the dapp title. `logoURL` and `logoHash` are copies of that dapp's logo (`data/dapps/<slug>/`). Dapps have no `all.json`; only tokens and providers publish an aggregate. Browser chips are `getDappCategories()` from `data/dapps/categories.json`.
