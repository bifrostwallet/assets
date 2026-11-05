# Using the catalog

Read providers and validators from [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets), or from GitHub raw `all.json` when you skip the package. To add a provider, token, or dapp, see [CONTRIBUTING.md](CONTRIBUTING.md).

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md): `eip155:14` (Flare), `eip155:19` (Songbird), and `xrpl:0` (XRPL). Directory names use a hyphen (`eip155-14`) because they are file paths. Function arguments use a colon (`eip155:14`). An unknown chain id throws. A missing provider returns `null`.

## Install

Pin one version and commit the lockfile.

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

pnpm uses `--save-exact`. Yarn uses `--exact`.

`PROVIDER_CHAIN_IDS` is `eip155:14` and `eip155:19`.

## Self-hosted logos

Self-hosted logos are the standard way to serve icons. The npm package ships the catalog records. Host the `logo.webp` files yourself.

1. Check out the tag `v` plus the version you pinned.
2. Copy logos from `data/providers`, `data/tokens`, `data/dapps`, and `data/contracts`.
3. Pass that host to `resolveAssetURL`. Repeat the copy when you change the pin.

Object keys stay `providers/<chain>/<identity>/logo.webp` under the base you pass in. The same layout applies to tokens, dapps, and contracts.

```bash
gcloud storage rsync data/providers gs://YOUR_BUCKET/assets/providers \
  --recursive \
  --exclude=".*\.json$"

aws s3 sync data/providers s3://YOUR_BUCKET/assets/providers \
  --exclude "*" \
  --include "*/*/logo.webp"
```

Google Cloud Storage: [Upload objects](https://cloud.google.com/storage/docs/uploading-objects). AWS: [`aws s3 sync`](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html).

### Logo URLs

In git, each entry's `info.json` stores a relative `logoURL`. Provider and token `all.json` files in git use absolute GitHub raw logo URLs. `logoURL` values in the npm package are relative: the build rewrites `all.json` back to relative paths. `upload:bucket` rebases a hosted `all.json` onto `ASSET_BASE_URL`.

`resolveAssetURL(logoURL, baseURL?)` joins a package `logoURL` to `baseURL`. The base is trimmed, and a trailing slash is added when it does not already end with one. The base you host is the directory that contains `providers/`, `tokens/`, `dapps/`, and `contracts/`. The same call works for a provider, token, dapp, or contract. Pass your own base when you host the files. When the base is omitted or blank, the helper uses `GITHUB_ASSET_BASE_URL`, GitHub raw at the tag for the installed version. `DEFAULT_ASSET_BASE_URL` is a deprecated alias of that prefix.

A path that is not an `http` or `https` URL loses one leading slash and is appended. An absolute URL is reduced to the path after `/static/` when that marker is present, otherwise to the path after `/data/`. When neither marker is present, it is reduced to the first `providers/`, `tokens/`, `dapps/`, or `contracts/` segment. The query string and hash are dropped. An absolute URL that matches none of those patterns is returned unchanged.

### Listed providers

Picker and discovery views use providers with `listed: true`. A confirmation or a transaction detail still shows a provider the user already chose, including one that is not listed.

```typescript
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
```

`getListedProviders(chainId)` returns providers with `listed: true`. `getProviders(chainId)` returns every provider on that chain. `getProvider(chainId, identityAddress)` returns one provider, or `null`, and the address match ignores case. `getManagementGroupProviders(chainId)` returns providers with `managementGroup: true`.

### Listed validators

`getListedValidators(chainId)` returns one entry per NodeID for providers with `listed: true`, in that provider order. Each entry has `nodeId`, `identityAddress`, and `name`. `getValidators(chainId)` returns every validator on the chain, including validators of providers that are not listed.

```typescript
import { getListedValidators } from "@bifrostwallet/assets";

const validators = getListedValidators("eip155:14");
```

### Validators for one identity

`getValidatorsByIdentity(chainId, identityAddress)` returns that provider's validators. The address match ignores case, and a missing identity returns an empty array. `findProviderByValidator(chainId, nodeId)` returns the provider that operates that NodeID, or `null`. The NodeID includes the `NodeID-` prefix.

```typescript
import {
  findProviderByValidator,
  getValidatorsByIdentity,
} from "@bifrostwallet/assets";

const own = getValidatorsByIdentity(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
const provider = findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
```

### Optional verification

A picker can skip this. The checks fit CI when you change the pin.

`logoHash` is the SHA-256 of the provider `logo.webp`: 64 lowercase hex characters, with no `0x` prefix. Compare it with the bytes you uploaded.

Operator signatures ship from `@bifrostwallet/assets/signatures`, so a normal import does not download them. `getProviderSignatures(chainId, identityAddress)` returns the record, or `null` when this version has no signature file for that identity. An unknown chain id throws. Some listings stay unsigned until 31 December 2026. The signed fields are under [Ownership signatures](README.md#ownership-signatures). Curator fields such as `listed` sit outside the signature.

`viem` is optional. `recoverTypedDataAddress` is a recommended way to recover the EIP-712 `ProviderListing` signer and compare it with `identityAddress`. `viem` is a dev dependency of this repository, not of the published package. Dev dependency names, without version numbers, are in the [repository README](https://github.com/bifrostwallet/assets/blob/main/README.md#supply-chain-security).

```js
import { createHash } from "node:crypto";
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const digest = createHash("sha256").update(logoBytes).digest("hex");
if (digest !== provider.logoHash) throw new Error("logo hash mismatch");

const record = getProviderSignatures("eip155:14", provider.identityAddress);
```

## GitHub raw all.json

Fetch GitHub raw `all.json` when you are not installing the package. How `logoURL` is stored is under [Logo URLs](#logo-urls).

1. Fetch `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/<chain>/all.json`. The chain directory uses a hyphen, such as `eip155-14` or `eip155-19`.
2. For listed providers, keep records with `listed: true` and use `logoURL` as published.
3. For listed validator NodeIDs, read `validators` on those records.

```js
const response = await fetch(
  "https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-14/all.json",
);
const providers = await response.json();
const listed = providers.filter((provider) => provider.listed);
const logoURL = listed[0]?.logoURL;
const nodeIds = listed.flatMap((provider) => provider.validators);
```

## Other lookups

`getTokens(chainId)`, `getToken(chainId, address)`, `getNativeToken(chainId)`, and `getXrplToken(issuer, currency)` read the token catalog. `getXrplToken` keeps the issuer and currency case. `getContracts` and `getContract` read contract names. `getDappCategories()` returns the browser chips. Logos use `resolveAssetURL` the same way as provider logos. The records themselves are described in [CONTRIBUTING.md](CONTRIBUTING.md).
