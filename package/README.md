# Consuming Assets

The supported way to consume Bifrost’s curated listings is [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets): an audited, zero-dependency package. Version-lock the release you ship, and read listings from that package. Source of truth: [`bifrostwallet/assets`](https://github.com/bifrostwallet/assets).

Most consumers are dapps and frontends. Their main job is listing every listed provider in comparison lists and pickers.

To list a provider, follow [FTSO provider](https://docs.bifrostwallet.com/list/ftso-provider) and the [assets README](https://github.com/bifrostwallet/assets/blob/main/README.md).

## Install

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

`--save-exact` and `--exact` pin one version so a newer catalog cannot slip in unnoticed. Commit the lockfile with that pin.

When you bump that pin, download the new tag and upload that release’s logo files before you ship. A version bump without refreshing icons is incomplete. The steps are under [Logos](#logos).

## Provider lookup

Chain ids are CAIP-2. These examples use Bifrost Wallet on Flare (`eip155:14`). `getProvider` matches `identityAddress` case-insensitively and returns `null` when that identity is not in this package version. An unknown chain id throws.

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

The package entry is CommonJS. `require("@bifrostwallet/assets")` exposes the same `getListedProviders`, `getProvider`, and `resolveAssetURL`.

| UI | Call |
| --- | --- |
| Comparison lists and provider **picker** / discovery | `getListedProviders` (`listed: true` only) |
| Confirmations and details | `getProvider`, including entries with `listed: false` |

## Logos

Logo files are not in the npm package. Each listing’s `logoURL` is a relative path, such as `providers/eip155-14/<identity>/logo.webp`. `logoHash` is the SHA-256 of that file.

Download or clone the git tag that matches your pinned package version. The tag is `v` plus that version. Upload `providers/**/logo.webp` from that tag to a CDN or backend you control, and keep the relative paths.

### When you bump the pinned version

Do this before you ship. Download that new tag and upload that release’s `providers/**/logo.webp` files again. A version bump without refreshing icons is incomplete.

If a listing’s file is missing on your host, the image is broken. Your host returns 404. That is what a newly added provider looks like after a bump you did not follow with an upload. A path you already uploaded keeps serving the old file. If the catalog logo changed, that file is stale and `logoHash` no longer matches.

### How resolveAssetURL uses your host

Always pass your host: `resolveAssetURL(logoURL, base)`. When you pass a base, the function only joins the relative path to that host. It does not fall back to GitHub or Bifrost’s CDN. The example base `https://cdn.example.com/assets/` is the directory that contains `providers/`. GitHub and Bifrost’s CDN are not logo hosts.

The GitHub raw fallback runs only when you omit the base or pass an empty base. Do not omit the base. Do not use that fallback as a logo host.

`resolveAssetURL` works the same way for any listing’s `logoURL` (tokens and dapps included).

Catalog logos are WebP (`logo.webp`).

## Optional checks

Most apps can skip this. There are two checks. There is no signature over the curated catalog yet.

### Logo hash

`logoHash` is the SHA-256 of `logo.webp`, as 64 lowercase hex characters, with no `0x` prefix. Hash the bytes you serve and compare them to `provider.logoHash`. A match means that CDN file was not swapped. Use the platform you already have. Do not add a dependency for this.

Node:

```js
import { createHash } from "node:crypto";

const digest = createHash("sha256").update(logoBytes).digest("hex");
if (digest !== provider.logoHash) throw new Error("logo hash mismatch");
```

Browsers, with Web Crypto:

```js
const digest = await crypto.subtle.digest("SHA-256", logoBytes);
const hex = [...new Uint8Array(digest)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("");
if (hex !== provider.logoHash) throw new Error("logo hash mismatch");
```

### Provider signature

The operator signature covers the signed fields: name, description, logo hash, website, links, identity, and the responsibilities acknowledgement. `logoHash` is one of those fields. Curator fields such as `listed` are not in that payload.

`signatures.json` is in the git listing. It is not in the npm package. Clone or download the same tag (`v` plus the package version) and, in that checkout, run:

```bash
./yarn verify:providers
```

That script uses `viem` as a dev dependency of this repository. Do not add `viem` to your production app.

Self-signatures are grandfathered until 31 December 2026. `./yarn verify:providers` without `--strict` is the current check. `--strict` requires a self-signature on every provider, and that mode waits until after 31 December 2026.

## Provenance

Releases are staged with npm Trusted Publishing (OIDC). The publish step sets `NPM_CONFIG_PROVENANCE`. The workflow is [`.github/workflows/release.yml`](https://github.com/bifrostwallet/assets/blob/main/.github/workflows/release.yml).

Confirm the green check on the npm version page. You can also run `npm audit signatures`. See [Viewing package provenance](https://docs.npmjs.com/viewing-package-provenance/).
