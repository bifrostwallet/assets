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

`getTokens(chainId)` returns that chain's tokens. `eip155:14` returns EVM tokens. An unknown chain id throws. Each `logoURL` is a relative path. `getToken(chainId, address)` returns one EVM token, or `null`. The address match ignores case.

Upload commands, app use, and optional verification are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).

## GitHub (backwards compatible)

Leave out the base. `resolveAssetURL` then uses `DEFAULT_ASSET_BASE_URL`, the GitHub raw prefix `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/`.

```typescript
import { getTokens, resolveAssetURL } from "@bifrostwallet/assets";

const [token] = getTokens("eip155:14");
const logoURL = resolveAssetURL(token.logoURL);
```
