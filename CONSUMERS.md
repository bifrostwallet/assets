# Consuming @bifrostwallet/assets

Pin [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets) to one version with `--save-exact` (npm and pnpm) or `--exact` (Yarn), and commit the lockfile. The install example is in the [package README](package/README.md).

To list a provider, follow [FTSO provider](https://docs.bifrostwallet.com/list/ftso-provider).

## 1. Hosting logos

> [!WARNING]
> Bumping `@bifrostwallet/assets` without uploading logos from the matching git tag to storage you control is an incomplete upgrade. The tag is `v` plus the package version. Logo files are not in the npm tarball.
>
> A path that is new in that version 404s. A path you already uploaded can keep the previous bytes, and `logoHash` will not match when the logo changed.
>
> Copy every logo tree you actually serve, and keep the relative paths:
>
> - `data/providers/**/logo.webp` (provider icons)
> - `data/tokens/**/logo.webp` (EVM and XRPL token icons)
> - `data/dapps/**/logo.webp` (dapp icons)
> - `data/contracts/**/logo.webp` (contract project icons and per-contract icons)

1. Check out the git tag `v<version>` for the version you pinned.
2. Upload `data/` from that checkout to a bucket you control. The commands below copy `logo.webp` and skip JSON files. Object keys stay `providers/…`, `tokens/…`, `dapps/…`, and `contracts/…` under the base you pass to `resolveAssetURL`.
3. Run the same upload again whenever you change the pin.

```bash
gcloud storage rsync data gs://YOUR_BUCKET/assets \
  --recursive \
  --exclude=".*\.json$"

aws s3 sync data s3://YOUR_BUCKET/assets \
  --exclude "*" \
  --include "*/*/logo.webp" \
  --include "*/*/*/logo.webp" \
  --include "*/*/*/*/logo.webp"
```

Google Cloud Storage: [Upload objects](https://cloud.google.com/storage/docs/uploading-objects). AWS: [`aws s3 sync`](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

## 2. Frontend use

Import the helpers and pass your host to `resolveAssetURL`. Chain ids are CAIP-2. A missing record returns `null`. An unknown chain id throws. `getListedProviders(chainId)` returns providers with `listed: true`, for a picker. `getProvider(chainId, identityAddress)` matches the identity address without regard to case, including a provider whose `listed` flag is false, for a confirmation screen. `getToken(chainId, address)` is the EVM token lookup and ignores address case. The token example in the [package README](package/README.md) uses `getTokens(chainId)`.

`resolveAssetURL(relativePath, baseURL?)` joins a listing `logoURL` to `baseURL`. When `baseURL` is omitted, empty, or only whitespace, the helper uses `DEFAULT_ASSET_BASE_URL` (`https://raw.githubusercontent.com/bifrostwallet/assets/main/data/`). The value used as the base is trimmed, and a trailing slash is added when it does not already end with one. A path that is not an `http` or `https` URL loses one leading slash and is appended. An absolute URL is reduced to the path after `/static/` when that marker is present, otherwise to the path after `/data/`. When neither marker is present, it is reduced to the first `providers/`, `tokens/`, `dapps/`, or `contracts/` segment. The query string and hash are dropped, and the relative path is appended to the base. An absolute URL that matches neither pattern is returned unchanged. The same call works for a provider, token, dapp, or contract `logoURL`. The base is the directory that contains `providers/`, `tokens/`, `dapps/`, and `contracts/`.

```typescript
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
```

## 3. Backend use

A Node server calls the same functions. One use at pin time is to write a JSON file beside the logos, with each `logoURL` already joined to your host, and let clients fetch that file. `getProviders(chainId)` returns every provider on the chain, including entries whose `listed` flag is false, when the file should include them. The published entry is CommonJS, so `require("@bifrostwallet/assets")` returns these same functions.

```js
import { writeFileSync } from "node:fs";
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
writeFileSync("flare-providers.json", JSON.stringify(listed));
```

## 4. Optional verification

A picker can skip this. The checks fit CI or a backend when you change the pin.

`logoHash` is the SHA-256 of `logo.webp`: 64 lowercase hex characters, with no `0x` prefix. Compare it with the bytes you uploaded. In a browser, `crypto.subtle.digest("SHA-256", logoBytes)` produces the same digest.

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
