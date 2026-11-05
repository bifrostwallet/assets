# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `xrpl:0`). Pin one version and commit the lockfile.

## Install

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

## Self-hosted logos

Self-hosted logos are the standard way to serve icons. Logo files are not in the npm package. Upload `data/` from the git tag `v<version>` that matches the pin to GCS or S3, and pass that host to `resolveAssetURL`.

```typescript
import { getTokens, resolveAssetURL } from "@bifrostwallet/assets";

const [token] = getTokens("eip155:14");
const logoURL = resolveAssetURL(token.logoURL, "https://cdn.example.com/assets/");
```

`getTokens(chainId)` returns that chain's tokens, and `getToken(chainId, address)` returns one EVM token or `null`.

Upload commands, app use, and optional verification are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).

## GitHub (backwards compatible)

Leave out the base. `resolveAssetURL` then loads logos from GitHub at the tag matching the installed version (`GITHUB_ASSET_BASE_URL`). `data/tokens/<chain>/all.json` and `data/providers/<chain>/all.json` on GitHub carry absolute logo URLs for use without the package.

```typescript
import { getTokens, resolveAssetURL } from "@bifrostwallet/assets";

const [token] = getTokens("eip155:14");
const logoURL = resolveAssetURL(token.logoURL);
```
