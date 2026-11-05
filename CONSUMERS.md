# Consuming @bifrostwallet/assets

Pin [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets) to one version with `--save-exact` (npm and pnpm) or `--exact` (Yarn), and commit the lockfile. The install example is in the [package README](package/README.md).

To list a provider, follow [FTSO provider](https://docs.bifrostwallet.com/list/ftso-provider).

## 1. Self-hosted logos

Self-hosted logos are the standard way to serve icons. Logo files are not in the npm package. The git tag is `v` plus the package version.

1. Check out the tag `v<version>` for the version you pinned.
2. From CI, upload the provider logos in `data/providers`. The commands copy `logo.webp` and skip JSON files. Object keys stay `providers/<chain>/<identity>/logo.webp` under the base you pass to `resolveAssetURL`.
3. Pass that host as the base. Repeat the upload when you change the pin.

The same pattern applies to tokens.

```bash
gcloud storage rsync data/providers gs://YOUR_BUCKET/assets/providers \
  --recursive \
  --exclude=".*\.json$"

aws s3 sync data/providers s3://YOUR_BUCKET/assets/providers \
  --exclude "*" \
  --include "*/*/logo.webp"
```

Google Cloud Storage: [Upload objects](https://cloud.google.com/storage/docs/uploading-objects). AWS: [`aws s3 sync`](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

### Get all listed providers

Chain ids are CAIP-2. Call `getListedProviders(chainId)` once per chain. It returns providers with `listed: true`. An unknown chain id throws. `getProviders(chainId)` returns every provider on the chain, including entries whose `listed` flag is false. `getProvider(chainId, identityAddress)` matches the identity address without regard to case and returns `null` when the identity is absent.

`resolveAssetURL(relativePath, baseURL?)` joins a listing `logoURL` to `baseURL`. The value used as the base is trimmed, and a trailing slash is added when it does not already end with one. A path that is not an `http` or `https` URL loses one leading slash and is appended. An absolute URL is reduced to the path after `/static/` when that marker is present, otherwise to the path after `/data/`. When neither marker is present, it is reduced to the first `providers/`, `tokens/`, `dapps/`, or `contracts/` segment. The query string and hash are dropped, and the relative path is appended to the base. An absolute URL that matches neither pattern is returned unchanged. When `baseURL` is omitted or blank, the helper uses `GITHUB_ASSET_BASE_URL`, GitHub raw at the tag matching the installed version. The base you host is the directory that contains `providers/`.

The same calls run in a browser, a dapp, or a server.

```typescript
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
```

### Listed validator NodeIDs

Each provider record includes `validators`, an array of NodeIDs. Listed validators are those NodeIDs on the result of `getListedProviders`. `findProviderByValidator(chainId, nodeId)` returns the provider that operates that NodeID, or `null`. The NodeID must match the stored string.

```typescript
import { findProviderByValidator, getListedProviders } from "@bifrostwallet/assets";

const listed = getListedProviders("eip155:14");
const nodeIds = listed.flatMap((provider) => provider.validators);
const provider = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
```

### Optional verification

A picker can skip this. The checks fit CI when you change the pin.

`logoHash` is the SHA-256 of the provider `logo.webp`: 64 lowercase hex characters, with no `0x` prefix. Compare it with the bytes you uploaded.

Operator signatures ship from `@bifrostwallet/assets/signatures`. Importing `@bifrostwallet/assets` does not load that entry. `getProviderSignatures(chainId, identityAddress)` returns the payload, or `null` when this version has no signature file for that identity. An unknown chain id throws. Some listings stay unsigned until 31 December 2026. The signature covers name, description, logo hash, website, links, identity, and the responsibilities acknowledgement. `logoHash` is one of those fields. Curator fields such as `listed` sit outside the signature. The version pin and npm provenance bind the published record. `record.verificationInstructions` states the domain and the field order.

`viem` is optional. `recoverTypedDataAddress` is a recommended way to recover the EIP-712 `ProviderListing` signer and compare it with `identityAddress`. `viem` is a devDependency of this repository, not of the published package. Dev dependency names, without version numbers, are in the [repository README](https://github.com/bifrostwallet/assets/blob/main/README.md#supply-chain-security).

Releases are staged with npm Trusted Publishing (OIDC). [`.github/workflows/release.yml`](https://github.com/bifrostwallet/assets/blob/main/.github/workflows/release.yml) runs `npm stage publish` with `NPM_CONFIG_PROVENANCE=true`. A maintainer approves the staged version on npmjs.com before it is installable. Confirm the green check on the npm version page, or run `npm audit signatures`. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/).

```js
import { createHash } from "node:crypto";
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const digest = createHash("sha256").update(logoBytes).digest("hex");
if (digest !== provider.logoHash) throw new Error("logo hash mismatch");

const record = getProviderSignatures("eip155:14", provider.identityAddress);
```

## 2. GitHub (backwards compatible)

This path does not use the package. Provider files on GitHub already store absolute `logoURL` values.

1. Fetch `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/<chain>/all.json`. The chain directory uses a hyphen, such as `eip155-14` or `eip155-19`.
2. For listed providers, keep records with `listed: true` and use `logoURL` as published.
3. For listed validator NodeIDs, read `validators` on those same records.

```js
const response = await fetch(
  "https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-14/all.json",
);
const providers = await response.json();
const listed = providers.filter((provider) => provider.listed);
const logoURL = listed[0].logoURL;
const nodeIds = listed.flatMap((provider) => provider.validators);
```
