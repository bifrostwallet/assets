# @bifrostwallet/assets

Curated catalog of tokens, FTSO data providers, dapps, and contracts for Bifrost Wallet.

Chain ids in the package are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `eip155:19`). Pin one version and commit the lockfile.

## Install

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

## Self-hosted logos

Self-hosted logos are the standard way to serve icons. Logo files are not in the npm package. From CI, upload `data/providers` from the git tag `v<version>` that matches the pin, and pass that host to `resolveAssetURL`. An unknown chain id throws. The same pattern applies to tokens.

### Get all listed providers

Call `getListedProviders(chainId)` once per chain. It returns providers with `listed: true`. Resolve each `logoURL` against your host.

```typescript
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
```

### Get all listed validators

`getListedValidators(chainId)` returns one entry per NodeID for providers with `listed: true`, in that provider order. Each entry has `nodeId`, `identityAddress`, and `name`.

```typescript
import { getListedValidators } from "@bifrostwallet/assets";

const validators = getListedValidators("eip155:14");
```

### Listed validator NodeIDs

Each provider has `validators`, an array of NodeIDs. Listed validators are the NodeIDs on the providers from `getListedProviders`. `findProviderByValidator(chainId, nodeId)` returns the provider for one NodeID, or `null`. The NodeID must match the stored string.

```typescript
import {
  findProviderByValidator,
  getListedProviders,
  resolveAssetURL,
} from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14");
const nodeIds = listed.flatMap((provider) => provider.validators);
const provider = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
const logoURL = provider ? resolveAssetURL(provider.logoURL, base) : null;
console.log(nodeIds.length, logoURL);
```

Upload commands and optional signature checks are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).

## GitHub (backwards compatible)

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
