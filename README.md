# @bifrostwallet/assets

Curated catalog of [FTSO](#glossary) providers, validators, tokens, contracts and dapps for Bifrost Wallet.

**Adding a provider:** [CONTRIBUTING.md](CONTRIBUTING.md). Tokens, contracts, and dapps are curated by the Bifrost team.

The listing form and intake API run outside this repository. Contact details stay on private intake objects. Security reports go to **security@bifrostwallet.com**. See [SECURITY.md](SECURITY.md).

## Using the package

Pin one version and commit the lockfile.

```sh
npm install @bifrostwallet/assets@<version> --save-exact
```

```sh
yarn add @bifrostwallet/assets@<version> --exact
```

`createAssets()` is the package entry. `baseURL` is optional. Omit it and logo URLs use jsDelivr for this exact package version:

`https://cdn.jsdelivr.net/gh/bifrostwallet/assets@v<version>/data/`

`<version>` is this package's version with one leading `v`, the same string as the GitHub Release tag (`v0.1.0-beta`, or `v1.0.0` when the version is 1.0.0). That string is written into the package at build time. Returned `logoURL` values are absolute. A missing record is still `null`.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets();
```

Pass `baseURL` when you host the files yourself. A trailing slash is optional. The examples further down do that.

### Verify the hash before you show a CDN logo

**If you load a logo from a public CDN, including the default jsDelivr URL, check the bytes against the hash in this package before you display or cache them.** The package hash is the trust anchor. The CDN is not.

`verifyLogoHash(bytes, logoHash)` is true when the SHA-256 of the decoded file bytes equals `logoHash`: 64 lowercase hex characters, no `0x` prefix. That is the same digest a provider listing signs.

Providers, tokens, and contracts carry `logoHash`. A validator has no separate image. Its `logoHash` is the operating provider's signed digest. Contract `logoHash` is filled in when the package is built, from the logo file. Token and provider hashes are stored in the catalog. Dapp logos are not returned by `createAssets`. Their existing catalog hashes are copied into `logo-hashes.json` (hash only, no logo bytes) so `fetch-logos` can check those files too.

```typescript
import { createAssets, verifyLogoHash } from "@bifrostwallet/assets";

const assets = createAssets();
const provider = assets.getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
if (!provider) throw new Error("missing listing");
const response = await fetch(provider.logoURL, {
  headers: { accept: "application/octet-stream" },
});
const bytes = new Uint8Array(await response.arrayBuffer());
if (!verifyLogoHash(bytes, provider.logoHash)) throw new Error("logo hash mismatch");
```

Ask for the bytes as-is. Do not send an `Accept` list of image types. Hash the body after content-encoding is removed. `verifyLogoHash` does that comparison.

### Self-hosting logos

Logo files are not in the npm package. You do not need to clone the repository.

1. Download this version's logos. The command checks each file against the hash in the installed package. A missing hash or a mismatch does not write that file, and the command exits non-zero. Do not upload the directory if it fails.

```sh
npx --yes @bifrostwallet/assets@<version> fetch-logos ./logos
```

Files land at `./logos/providers/…`, `./logos/tokens/…`, `./logos/contracts/…`, and `./logos/dapps/…`.

2. Upload that directory to any static host or bucket. The public URL must serve those paths at its root. [Cloud Storage](https://cloud.google.com/storage/docs/uploading-objects) or [S3](https://docs.aws.amazon.com/cli/latest/reference/s3/sync.html) can do that.

3. Point the package at the public URL:

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
});
```

4. When you bump `@bifrostwallet/assets`, run `fetch-logos` for the new version and upload again before you ship. The default jsDelivr URL changes with the version. A copy you host does not.

### Listed providers

Picker and discovery views use providers with `listed: true`. A confirmation or a transaction detail still shows a provider the user already chose, including one that is not listed.

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md): `eip155:14` (Flare), `eip155:19` (Songbird), and `xrpl:0` (XRPL). An unknown chain id throws. A missing provider returns `null`.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
});
const listed = assets.getListedProviders("eip155:14");
// [
//   {
//     name: "Bifrost Wallet",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     listed: true,
//     logoURL:
//       "https://assets.example.com/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
//     validators: ["NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP", ...],
//     ...
//   },
//   ...
// ]
```

`assets.getListedProviders(chainId)` returns providers with `listed: true`. `assets.getProviders(chainId)` returns every provider on that chain. `assets.getProvider(chainId, identityAddress)` returns one provider, or `null`, and the address match ignores case. `assets.getManagementGroupProviders(chainId)` returns providers with `managementGroup: true`.

### Listed validators

`assets.getListedValidators(chainId)` returns one entry per NodeID for providers with `listed: true`, in that provider order. Each entry has `nodeId`, `identityAddress`, `name`, and the operating provider's `logoURL`. `assets.getValidators(chainId)` returns every validator on the chain, including validators of providers that are not listed.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
});
const validators = assets.getListedValidators("eip155:14");
// [
//   {
//     nodeId: "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     name: "Bifrost Wallet",
//     logoURL:
//       "https://assets.example.com/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
//   },
//   // ...
// ]
```

### Validators for one identity

`assets.getValidatorsByIdentity(chainId, identityAddress)` returns that provider's validators. The address match ignores case, and a missing identity returns an empty array. `assets.findProviderByValidator(chainId, nodeId)` returns the provider that operates that NodeID, or `null`. The NodeID includes the `NodeID-` prefix.

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
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
//   logoURL:
//     "https://assets.example.com/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
// }
// followed by three more NodeIDs for that identity.
// provider is { name: "Bifrost Wallet", identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364", listed: true, ... }
```

### Other lookups

`assets.getTokens(chainId)`, `assets.getToken(chainId, address)`, `assets.getNativeToken(chainId)`, and `assets.getXrplToken(issuer, currency)` read the token catalog. `getXrplToken` keeps the issuer and currency case. `assets.getContracts` and `assets.getContract` read contract names. `assets.getDappCategories()` returns the browser chips. `logoURL` on each record is already absolute. The records themselves are described in [CONTRIBUTING.md](CONTRIBUTING.md).

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
});
const flr = assets.getNativeToken(
  "eip155:14",
);
// {
//   name: "Flare",
//   symbol: "FLR",
//   decimals: 18,
//   address: null,
//   ...
// }

const wflr = assets.getToken(
  "eip155:14",
  "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d",
);
// {
//   name: "Wrapped Flare",
//   symbol: "WFLR",
//   decimals: 18,
//   address: "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d",
//   logoURL:
//     "https://assets.example.com/tokens/eip155-14/0x1d80c49bbbcd1c0911346656b529df9e5c2f783d/logo.webp",
//   ...
// }

const issued = assets.getXrplToken(
  "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h",
  "ETH",
);
// {
//   name: "GateHub ETH",
//   symbol: "ETH",
//   issuer: "rcA8X3TVMST1n3CJeAdGk1RdRCHii7N2h",
//   currency: "ETH",
//   ...
// }

const chips = assets.getDappCategories();
// [
//   {
//     id: "featured",
//     label: "Featured",
//     dapps: [],
//   },
//   {
//     id: "dex",
//     label: "DEX",
//     dapps: ["sparkdex-ai", "blazeswap-xyz", ...],
//   },
//   ...
// ]
```

### Signatures

Operator signatures ship from `@bifrostwallet/assets/signatures`, so a normal import does not download them. `getProviderSignatures(chainId, identityAddress)` returns the record, or `null` when this version has no signature file for that identity. An unknown chain id throws. Some listings stay unsigned until 31 December 2026. Curator fields such as `listed` sit outside the signature.

`logoHash` is the SHA-256 of the provider `logo.webp`: 64 lowercase hex characters, with no `0x` prefix. Compare it with the bytes you host.

The signature is EIP-712 (`eth_signTypedData_v4`) over `ProviderListing`, self-signed by the identity address. Changing any signed field needs a new signature.

**Domain**

| Field | Value |
| --- | --- |
| `name` | `"Bifrost Assets"` |
| `version` | `"1"` |
| `chainId` | The id in `eip155-<id>`. Flare is 14. Songbird is 19. |
| `salt` | `keccak256` of the UTF-8 string `https://bifrostwallet.com` |

**Content hash**

`messageHash` in `signatures.json` and `contentHash` are the same value: `0x` plus the SHA-256 of one canonical JSON string. Keys that are set stay in this order. `logoHash` is the unprefixed hex.

```js
JSON.stringify({
  name,
  description,
  logoHash,
  websiteURL,
  links,
  identityAddress,
  acknowledgedResponsibilities,
})
```

**links**

`links` includes only the links that are set, with keys in this order: `github`, `x`, `discord`, `telegram`, `youtube`, `reddit`, `linkedin`, `tiktok`. `linksJson` is `JSON.stringify` of that same object.

Recover the signer with `viem`, which is installed separately and is not part of this package. Compare the recovered address with `identityAddress` without regard to case.

```typescript
import { createHash } from "node:crypto";
import { keccak256, recoverTypedDataAddress, toBytes } from "viem";
import { createAssets } from "@bifrostwallet/assets";
import { getProviderSignatures } from "@bifrostwallet/assets/signatures";

const assets = createAssets({
  baseURL: "https://assets.example.com/",
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

## jsDelivr all.json (Legacy)

Fetch provider `all.json` from jsDelivr on `@main` when you are not installing the package. `logoURL` in that file is already absolute and uses the same `@main` snapshot. There is no token `all.json`. Token lists are not published that way; use `createAssets`.

`@main` is the moving catalog, not a release tag. Callers of this file want the current listings. jsDelivr can cache a branch for about 12 hours, so a logo change can lag. The npm package pins `@v<version>` instead, so its logos match the installed data.

Compared with the package and logos you host:

- No version pin. The URL is `@main`, so changes arrive unannounced and can break you.
- List and logo requests from your users go to jsDelivr.
- Providers and their validator NodeIDs only. No tokens, contracts, dapps, or dapp categories.
- No TypeScript types, and no helpers for lookups, listed filters, or finding a provider from a validator.
- No signature checks. Those ship on `@bifrostwallet/assets/signatures`.

1. Fetch `https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/providers/<chain>/all.json`. The chain directory uses a hyphen, such as `eip155-14` or `eip155-19`.
2. For listed providers, keep records with `listed: true`. Check `logoHash` against the logo bytes before you display the image. `logoURL` is absolute.
3. For listed validator NodeIDs, read `validators` on those records. The logo is the provider logo.

```js
const response = await fetch(
  "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/providers/eip155-14/all.json",
);
const providers = await response.json();
const listed = providers.filter((provider) => provider.listed);
const logoURL = listed[0]?.logoURL;
const nodeIds = listed.flatMap((provider) => provider.validators);
// logoURL is
// "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp"
// nodeIds starts ["NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP", ...]
```

## Glossary

| Term | Meaning |
| --- | --- |
| [FTSO](https://dev.flare.network/ftso/overview) | Flare Time Series Oracle, the price feeds a provider submits. |
| [FSP](https://dev.flare.network/network/fsp) | Flare Systems Protocol, which records provider rewards and participation. |
| [FDC](https://dev.flare.network/fdc/overview) | Flare Data Connector, the attestation service a provider runs. |
