# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `xrpl:0`). An exact pin keeps the catalog on the version you installed until you change it. Commit the lockfile.

1. Install the package.

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

2. Read the tokens for a chain and resolve a logo. `getTokens(chainId)` returns that chain's tokens. `eip155:14` returns EVM tokens. An unknown chain id throws. Each `logoURL` is a relative path.

```typescript
import { getTokens, resolveAssetURL } from "@bifrostwallet/assets";

const [token] = getTokens("eip155:14");
const logoURL = resolveAssetURL(token.logoURL, "https://cdn.example.com/assets/");
```

`getToken(chainId, address)` returns one EVM token, or `null`. The address match ignores case. Pass your host as the second argument of `resolveAssetURL(relativePath, baseURL?)`. [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md) describes that helper, including the GitHub raw fallback used when the base is omitted or blank.

3. Host the logo files yourself. They are not in the npm tarball. Upload `data/` from the matching `v<version>` git tag to GCS or S3, and pass that host as the base.

Hosting steps, frontend and backend use, and optional checks are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).
