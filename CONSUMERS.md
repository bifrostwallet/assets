# Consuming Assets

Most consumers are dapps and frontends. Pin [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets), copy the logo trees you serve onto a host you control, and read listings from the package or from one JSON file on that same host. Source of truth: [`bifrostwallet/assets`](https://github.com/bifrostwallet/assets).

Lookups for providers, tokens, XRPL issued tokens, dapp categories, and contracts are in the [repository README](https://github.com/bifrostwallet/assets/blob/main/README.md#usage). This file is the upload guide.

To list a provider, follow [FTSO provider](https://docs.bifrostwallet.com/list/ftso-provider).

## 1. Pin the package

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

`--save-exact` and `--exact` pin one version so a newer catalog cannot slip in unnoticed. Commit the lockfile. Copy logos from that same version before you ship. The next section is the warning for that upload.

## 2. Copy logos when you adopt or bump

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

Use the exact pin from the previous step (`--save-exact` on npm and pnpm, `--exact` on Yarn) for that tag. Do this the first time, and again on every bump, before you ship.

| You serve | Copy from the tag | `logoURL` shape |
| --- | --- | --- |
| Providers | `data/providers/**/logo.webp` | `providers/eip155-14/<identity>/logo.webp` |
| Tokens | `data/tokens/**/logo.webp` | `tokens/eip155-14/<address>/logo.webp`, `tokens/eip155-14/native/logo.webp`, `tokens/xrpl-0/<issuer>/<currency>/logo.webp` |
| Dapps | `data/dapps/**/logo.webp` | `dapps/<slug>/logo.webp` |
| Contracts | `data/contracts/**/logo.webp` | `contracts/projects/<slug>/logo.webp`, `contracts/eip155-14/<address>/logo.webp` |

If you want one hosted JSON file, write it from the package in the same step and upload it next to the logos. Name the file whatever you want.

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

`getListedProviders` is the comparison list and picker (`listed: true` only). Use `getProviders` when the file should also include providers that are not listed.

Copy commands are in [Upload examples](#upload-examples).

## 3. Read listings

Import the helpers, or fetch the one file you uploaded. You do not call GitHub or Bifrost.

```typescript
import {
  getListedProviders,
  getProvider,
  resolveAssetURL,
} from "@bifrostwallet/assets";

// Comparison lists and pickers: listed: true only
const listed = getListedProviders("eip155:14");

// Confirmations and details, including entries that are not listed.
// This identity is Bifrost Wallet. getProvider returns null when it is absent.
const provider = getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
if (!provider) throw new Error("Provider is not in this package version");

const logoURL = resolveAssetURL(
  provider.logoURL,
  "https://cdn.example.com/assets/",
);
```

Chain ids are CAIP-2. `getProvider` matches `identityAddress` case-insensitively. An unknown chain id throws. The package entry is CommonJS. `require("@bifrostwallet/assets")` exposes the same functions.

| UI | Call |
| --- | --- |
| Comparison lists and provider **picker** / discovery | `getListedProviders` (`listed: true` only) |
| Confirmations and details | `getProvider`, including entries with `listed: false` |

`logoURL` in the package is a relative path. Always pass your host to `resolveAssetURL(logoURL, base)`. When you pass a base, it only joins that path to your host. It does not fall back to GitHub or Bifrost’s CDN. The example base is the directory that contains `providers/`. GitHub and Bifrost’s CDN are not logo hosts.

The GitHub raw fallback runs only when you omit the base or pass an empty base. Do not omit the base.

`resolveAssetURL` works the same way for any listing’s `logoURL` (tokens, dapps, and contracts included). Catalog logos are WebP. Token, XRPL, contract, and dapp-category calls use the same CAIP-2 chain ids and the same base rule. Examples are in the [repository README](https://github.com/bifrostwallet/assets/blob/main/README.md#usage).

If you uploaded `flare-providers.json`, fetch that URL. One request. Its `logoURL` values already point at your host.

## Do and do not

DO: pin with `--save-exact` / `--exact` and commit the lockfile.

DO NOT: depend on a `^` range. A newer catalog can slip in without a logo refresh.

DO: at each pin bump, copy every logo tree you serve from the tag `v` plus the version onto a host you control, and keep the relative paths. Provider icons are `data/providers/**/logo.webp`. Token icons are `data/tokens/**/logo.webp`. Dapp icons are `data/dapps/**/logo.webp`. Contract icons are `data/contracts/**/logo.webp`. If you want one JSON file, generate it with the lookup helpers plus `resolveAssetURL`, and upload it next to the logos.

DO NOT: fetch `all.json`, or logos, from GitHub raw, from this repository, or from Bifrost’s CDN at runtime. `all.json` in git is not a public consume API.

DO: call `resolveAssetURL(logoURL, yourBase)` and serve icons from your host.

DO NOT: omit the base. That falls back to GitHub. Do not serve icons from `node_modules`.

DO: import `getListedProviders` and `getProvider` for a picker. Import `@bifrostwallet/assets/signatures` only if you will verify.

DO NOT: assume signatures are fields on each provider from the main listing.

DO: in CI at pin-bump, compare logo bytes to `logoHash`. You can also recover the operator signature with `viem`.

DO NOT: require every frontend to install `viem`, or to recover EIP-712 signatures in the browser. There is no catalog signature to require.

## Upload examples

From a checkout of tag `v<version>`:

```bash
gcloud storage rsync data/providers gs://YOUR_BUCKET/assets/providers \
  --recursive \
  --exclude=".*\.json$"
gcloud storage rsync data/tokens gs://YOUR_BUCKET/assets/tokens \
  --recursive \
  --exclude=".*\.json$"
gcloud storage rsync data/dapps gs://YOUR_BUCKET/assets/dapps \
  --recursive \
  --exclude=".*\.json$"
gcloud storage rsync data/contracts gs://YOUR_BUCKET/assets/contracts \
  --recursive \
  --exclude=".*\.json$"
```

See [Upload objects](https://cloud.google.com/storage/docs/uploading-objects).

```bash
# Providers: chain/identity/logo.webp
aws s3 sync data/providers s3://YOUR_BUCKET/assets/providers \
  --exclude "*" \
  --include "*/*/logo.webp"

# EVM tokens: chain/address/logo.webp and chain/native/logo.webp.
# XRPL issued tokens: xrpl-0/issuer/currency/logo.webp.
aws s3 sync data/tokens s3://YOUR_BUCKET/assets/tokens \
  --exclude "*" \
  --include "*/*/logo.webp" \
  --include "*/*/*/logo.webp"

# Dapps: slug/logo.webp
aws s3 sync data/dapps s3://YOUR_BUCKET/assets/dapps \
  --exclude "*" \
  --include "*/logo.webp"

# Contract projects: projects/<slug>/logo.webp
# Per-contract logos: <chain>/<address>/logo.webp
aws s3 sync data/contracts s3://YOUR_BUCKET/assets/contracts \
  --exclude "*" \
  --include "*/*/logo.webp"
```

See [`aws s3 sync`](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

Run the same copy on every pin bump. Object keys stay under the base you pass to `resolveAssetURL` (`providers/…`, `tokens/…`, `dapps/…`, `contracts/…`).

## Optional checks

Most picker UIs skip this. Run it in CI, or on a backend, when you bump the pin.

### Logo hash

`logoHash` is the SHA-256 of `logo.webp`: 64 lowercase hex characters, no `0x` prefix. Compare it with the bytes you uploaded.

Node:

```js
import { createHash } from "node:crypto";

const digest = createHash("sha256").update(logoBytes).digest("hex");
if (digest !== provider.logoHash) throw new Error("logo hash mismatch");
```

Browsers:

```js
const digest = await crypto.subtle.digest("SHA-256", logoBytes);
const hex = [...new Uint8Array(digest)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
if (hex !== provider.logoHash) throw new Error("logo hash mismatch");
```

A check in the client at request time is optional. Use it when you do not fully trust the host that serves the icon.

### Provider signature

The operator signature covers name, description, logo hash, website, links, identity, and the responsibilities acknowledgement. `logoHash` is one of those fields. Curator fields such as `listed` are not. The pin and npm provenance bind those fields.

Signatures ship as a separate entry. Importing `@bifrostwallet/assets` does not download them.

```js
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const record = getProviderSignatures("eip155:14", provider.identityAddress);
```

`getProviderSignatures` returns `null` when this version has no signature file for that identity. Some listings stay unsigned until 31 December 2026.

Recover the EIP-712 `ProviderListing` signer and compare it to `identityAddress`. [`viem`](https://viem.sh) `recoverTypedDataAddress` does that recovery. `record.verificationInstructions` states the domain and the field order. Do this in CI or on a backend. A picker should not recover signatures in the browser.

## Provenance

Releases are staged with npm Trusted Publishing (OIDC). [`.github/workflows/release.yml`](https://github.com/bifrostwallet/assets/blob/main/.github/workflows/release.yml) runs `npm stage publish` with `NPM_CONFIG_PROVENANCE=true`. A maintainer approves the staged version on npmjs.com before it is installable. Pin with `--exact` or `--save-exact`, as above.

Confirm the green check on the npm version page. You can also run `npm audit signatures`. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/). Dev dependencies are named in the [README](https://github.com/bifrostwallet/assets/blob/main/README.md#supply-chain-security).
