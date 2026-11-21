# Maintainers

## Publishing

`./yarn build:package` writes `dist/` without logo files. Provider signatures are published on `@bifrostwallet/assets/signatures`. The main entry does not load that subpath. npm shows this repository's README.

Pin dev dependencies to exact versions. They are not published.

From 1.0.0, a GitHub Release tagged with the package version stages `dist/` through npm Trusted Publishing, with provenance, on the `latest` dist-tag. Mark the GitHub Release as a plain release, not a pre-release. Approve the staged version on npmjs.com and confirm the provenance badge ([Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/)).

## Logos on the Bifrost CDN

This repository does not upload logos. When bifrost-backend bumps its `@bifrostwallet/assets` pin, its Asset Logos workflow checks out the matching tag and copies the `logo.webp` files to the production and staging static buckets, including the legacy `res/icons/<address>.webp` keys that wallet builds before 0.7.58 load. Catalog data is served from the npm package.

## Listing submissions

The Pull listing submissions workflow runs `./yarn pull:submissions` daily against the intake bucket. To run it locally, sign in with `gcloud auth login` and run `./yarn with:ops-config -- ./yarn pull:submissions`. It uses `GCS_ACCESS_TOKEN` when set, otherwise `gcloud auth print-access-token`. `./yarn ops:pull-env` refreshes the local cache of `INTAKE_BUCKET` and `ASSET_BASE_URL`, which come from the private ops config, not from this repository.

## Catalog refresh

The nightly job proposes domain-linkage, delegation-fee, reward, chain-drift, management-group, and dual-network updates together on the `nightly/fsp-delist` pull request. Dual-network is computed from a shared identity address, a website domain linked on both Flare and Songbird, or the same normalized name. Management-group membership is read from each network's PollingManagementGroup and written onto existing listings. On-chain members with no catalog entry are warned about and are not added. A failed chain read fails the job. A curator merges that pull request. Listing rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Working in this repository

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install`.
2. Run `./yarn lint && ./yarn test` (`./yarn lint:fix` applies the automatic fixes).
3. Push reviewed changes directly to `main`.
