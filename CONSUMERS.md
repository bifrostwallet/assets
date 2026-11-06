# Using the catalog

Read providers and validators from [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets), or from GitHub raw `all.json` when you skip the package. To add a provider, token, or dapp, see [CONTRIBUTING.md](CONTRIBUTING.md).

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md): `eip155:14` (Flare), `eip155:19` (Songbird), and `xrpl:0` (XRPL). An unknown chain id throws. A missing provider returns `null`.

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
3. Pass that host to `createAssets` as `baseURL`. Repeat the copy when you change the pin.

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

In git, each entry's `info.json` stores a relative `logoURL`. Provider and token `all.json` files in git use absolute GitHub raw logo URLs. The npm package stores those paths relative, and `createAssets` joins them to `baseURL`. `upload:bucket` rebases a hosted `all.json` onto the base configured for that upload.

`createAssets({ baseURL })` is the package entry. `baseURL` is required. It is the directory that contains `providers/`, `tokens/`, `dapps/`, and `contracts/`: the host you copied the files to, or raw GitHub for the tag you pinned. A trailing slash is optional. Returned `logoURL` values are absolute. A missing record is still `null`.

### Listed providers

Picker and discovery views use providers with `listed: true`. A confirmation or a transaction detail still shows a provider the user already chose, including one that is not listed.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const listed = assets.getListedProviders("eip155:14");
// [
//   {
//     name: "Bifrost Wallet",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     listed: true,
//     logoURL:
//       "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
//     validators: ["NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP", ...],
//     ...
//   },
//   ...
// ]
```

`assets.getListedProviders(chainId)` returns providers with `listed: true`. `assets.getProviders(chainId)` returns every provider on that chain. `assets.getProvider(chainId, identityAddress)` returns one provider, or `null`, and the address match ignores case. `assets.getManagementGroupProviders(chainId)` returns providers with `managementGroup: true`.

### Listed validators

`assets.getListedValidators(chainId)` returns one entry per NodeID for providers with `listed: true`, in that provider order. Each entry has `nodeId`, `identityAddress`, and `name`. `assets.getValidators(chainId)` returns every validator on the chain, including validators of providers that are not listed.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const validators = assets.getListedValidators("eip155:14");
// [
//   {
//     nodeId: "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     name: "Bifrost Wallet",
//   },
//   // ...
// ]
```

### Validators for one identity

`assets.getValidatorsByIdentity(chainId, identityAddress)` returns that provider's validators. The address match ignores case, and a missing identity returns an empty array. `assets.findProviderByValidator(chainId, nodeId)` returns the provider that operates that NodeID, or `null`. The NodeID includes the `NodeID-` prefix.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const own = assets.getValidatorsByIdentity(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
const provider = assets.findProviderByValidator(
  "eip155:14",
  "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
);
// own[0] is
// {
//   nodeId: "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
//   identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//   name: "Bifrost Wallet",
// }
// followed by three more NodeIDs for that identity.
// provider is { name: "Bifrost Wallet", identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364", listed: true, ... }
```

### Optional verification

A picker can skip this. The checks fit CI when you change the pin.

`logoHash` is the SHA-256 of the provider `logo.webp`: 64 lowercase hex characters, with no `0x` prefix. Compare it with the bytes you uploaded.

Operator signatures ship from `@bifrostwallet/assets/signatures`, so a normal import does not download them. `getProviderSignatures(chainId, identityAddress)` returns the record, or `null` when this version has no signature file for that identity. An unknown chain id throws. Some listings stay unsigned until 31 December 2026. The signed fields are under [Ownership signatures](README.md#ownership-signatures). Curator fields such as `listed` sit outside the signature.

Compare `logoHash` with the SHA-256 of the logo bytes you host. Recover the signer with `viem`, which is installed separately and is not part of this package. `linksJson` is `JSON.stringify` of the signed links, keys in this order and only when set: `github`, `x`, `discord`, `telegram`, `youtube`, `reddit`, `linkedin`, `tiktok`. Compare the recovered address with `identityAddress` without regard to case.

```typescript
import { createHash } from "node:crypto";
import { keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { createAssets } from "@bifrostwallet/assets";
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const identity = "0x1650d2760baee638c034200dedcbe17b050d0364";
const provider = assets.getProvider("eip155:14", identity);
const record = getProviderSignatures("eip155:14", identity);
const entry = record?.signatures[0];
if (!provider || !entry) throw new Error("missing listing");

const digest = createHash("sha256").update(logoBytes).digest("hex");
if (digest !== provider.logoHash) throw new Error("logo hash mismatch");

const recovered = await recoverTypedDataAddress({
  domain: {
    name: "Bifrost Assets",
    version: "1",
    chainId: 14,
    salt: keccak256(toBytes("https://bifrostwallet.com")),
  },
  types: {
    ProviderListing: [
      { name: "name", type: "string" },
      { name: "description", type: "string" },
      { name: "websiteURL", type: "string" },
      { name: "logoHash", type: "bytes32" },
      { name: "identityAddress", type: "address" },
      { name: "linksJson", type: "string" },
      { name: "acknowledgedResponsibilities", type: "bool" },
      { name: "contentHash", type: "bytes32" },
    ],
  },
  primaryType: "ProviderListing",
  message: {
    name: provider.name,
    description: provider.description,
    websiteURL: provider.websiteURL,
    logoHash: `0x${provider.logoHash}`,
    identityAddress: provider.identityAddress,
    linksJson: JSON.stringify(provider.links),
    acknowledgedResponsibilities: provider.acknowledgedResponsibilities === true,
    contentHash: entry.messageHash,
  },
  signature: entry.signature as `0x${string}`,
});
// "0x1650d2760BAee638c034200DEdCBe17B050d0364"
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
// logoURL is
// "https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp"
// nodeIds starts ["NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP", ...]
```

## Other lookups

`assets.getTokens(chainId)`, `assets.getToken(chainId, address)`, `assets.getNativeToken(chainId)`, and `assets.getXrplToken(issuer, currency)` read the token catalog. `getXrplToken` keeps the issuer and currency case. `assets.getContracts` and `assets.getContract` read contract names. `assets.getDappCategories()` returns the browser chips. `logoURL` on each record is already absolute. The records themselves are described in [CONTRIBUTING.md](CONTRIBUTING.md).

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const flare = assets.getNativeToken("eip155:14");
// { name: "Flare", symbol: "FLR", decimals: 18, address: null, ... }

const wflr = assets.getToken("eip155:14", "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d");
// {
//   name: "Wrapped Flare",
//   symbol: "WFLR",
//   decimals: 18,
//   address: "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d",
//   logoURL:
//     "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/tokens/eip155-14/0x1d80c49bbbcd1c0911346656b529df9e5c2f783d/logo.webp",
//   ...
// }

const issued = assets.getXrplToken("rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", "ETH");
// { name: "GateHub ETH", symbol: "ETH", issuer: "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h", currency: "ETH", ... }

const chips = assets.getDappCategories();
// [{ id: "featured", label: "Featured", dapps: [] }, { id: "dex", label: "DEX", dapps: ["sparkdex-ai", "blazeswap-xyz", ...] }, ...]
```
