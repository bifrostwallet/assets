# Maintainers

## Publishing

`./yarn build:package` writes `dist/` without logo files. Provider signatures are published on `@bifrostwallet/assets/signatures`. The main entry does not load that subpath. npm shows this repository's README.

Pin dev dependencies to exact versions. They are not published.

A GitHub Release tagged `v` plus the package version stages `dist/` through npm Trusted Publishing, with provenance, on the `latest` dist-tag. Mark the GitHub Release as a plain release, not a pre-release. Approve the staged version on npmjs.com and confirm the provenance badge ([Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/)).

## Logos on a bucket or CDN

`./yarn with:ops-config -- ./yarn upload:bucket` uploads logo files only. It does not upload `all.json` or any other JSON. Catalog data is served from the npm package. Pass `--dry-run` to preview. `./yarn ops:pull-env` refreshes the local cache of the same variables. Values come from the private ops config, not from this repository:

- `STATIC_BUCKET`
- `STATIC_BUCKET_PROJECT_ID`
- `BUCKET_PREFIX`

## Catalog refresh

The nightly job proposes domain-linkage, delegation-fee, reward, and chain-drift updates together on the `nightly/fsp-delist` pull request. A curator merges that pull request. Listing rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Working in this repository

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install`.
2. Run `./yarn lint && ./yarn test` (`./yarn lint:fix` applies the automatic fixes).
3. Push reviewed changes directly to `main`.
