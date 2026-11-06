# Maintainers

## Publishing

`./yarn build:package` writes `dist/` without logo files. Provider signatures are published on `@bifrostwallet/assets/signatures`. The main entry does not load that subpath. npm shows this repository's README.

Pin dev dependencies to exact versions. They are not published.

A GitHub Release tagged `v` plus the package version stages `dist/` through npm Trusted Publishing, with provenance, under the beta tag. Approve the staged version on npmjs.com and confirm the provenance badge ([Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/)).

## Logos on a bucket or CDN

Check out the tag `v` plus the published version. Copy `logo.webp` from `data/providers`, `data/tokens`, `data/dapps`, and `data/contracts`. Repeat the copy when the pin changes.

Object keys stay `providers/<chain>/<identity>/logo.webp` under the base you pass to `createAssets`. The same layout applies to tokens, dapps, and contracts.

```bash
gcloud storage rsync data/providers gs://YOUR_BUCKET/assets/providers \
  --recursive \
  --exclude=".*\.json$"

aws s3 sync data/providers s3://YOUR_BUCKET/assets/providers \
  --exclude "*" \
  --include "*/*/logo.webp"
```

Google Cloud Storage: [Upload objects](https://cloud.google.com/storage/docs/uploading-objects). AWS: [`aws s3 sync`](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

`./yarn upload:bucket` uploads the catalog to the configured bucket. `BUCKET_PREFIX` is an optional object-key prefix. `ASSET_BASE_URL` is the base written into the hosted `all.json` logo URLs. Auth uses Application Default Credentials. Pass `--dry-run` to preview.

## Catalog refresh

The nightly job proposes domain-linkage, delegation-fee, reward, and chain-drift updates together on the `nightly/fsp-delist` pull request. A curator merges that pull request. Listing rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Working in this repository

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install`.
2. Run `./yarn lint && ./yarn test` (`./yarn lint:fix` applies the automatic fixes).
3. Push reviewed changes directly to `main`.
