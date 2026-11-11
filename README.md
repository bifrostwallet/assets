# @bifrostwallet/assets

Curated catalog of [FTSO](#glossary) providers, validators, tokens, contracts and dapps for Bifrost Wallet.

**Adding a provider:** [CONTRIBUTING.md](CONTRIBUTING.md). Tokens, contracts, and dapps are curated by the Bifrost team.

## Using the package

Pin one version and commit the lockfile.

```sh
npm install @bifrostwallet/assets@<version> --save-exact
```

```sh
yarn add @bifrostwallet/assets@<version> --exact
```

`createAssets()` is the package entry. `baseURL` is optional. Omit it and logo URLs use jsDelivr for this release tag:

`https://cdn.jsdelivr.net/gh/bifrostwallet/assets@<version>/data/`

`<version>` is the package version and the git tag (`1.1.0`). That tag is written into the package at build time. Returned `logoURL` values are absolute. A missing record is still `null`.

An exact version tag is immutable on jsDelivr. Cache headers last one year, and the file is stored permanently, so this pinned URL does not go stale ([Caching](https://www.jsdelivr.com/documentation#id-caching)). Self-host when you want a copy you control: `npx @bifrostwallet/assets@<version> fetch-logos ./logos` checks each file against the hash in that package. Pin the exact version and run it again on every bump.

Don't load logos from `raw.githubusercontent.com`. GitHub's raw file host is not a CDN: it rate-limits requests per IP and returns HTTP 429 under load. jsDelivr is built for this traffic.

```tsx
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets();
const provider = assets.getProvider(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);

{provider && <img src={provider.logoURL} alt="" />}
```

Pass `baseURL` when you host the files yourself. A trailing slash is optional. The examples further down do that.

### Optional: check a downloaded logo

Use this when you download logos or self-host them with `fetch-logos`. `verifyLogoHash(bytes, logoHash)` is true when the SHA-256 of the decoded file bytes equals `logoHash`: 64 lowercase hex characters, no `0x` prefix. `fetchLogo(entry)` is a convenience that downloads `logoURL` and runs that check in one step.

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

`assets.getTokens(chainId)`, `assets.getToken(chainId, address)`, `assets.getNativeToken(chainId)`, and `assets.getXrplToken(issuer, currency)` read the token catalog. `getXrplToken` keeps the issuer and currency case. `assets.getContracts` and `assets.getContract` read contract names. `assets.getDapps()` returns every dapp, and `assets.getDapp(slug)` returns one dapp or `null`. `assets.getDappCategories()` returns the browser chips. Show a dapp with `logoURL`, the same as a provider or token. The records themselves are described in [CONTRIBUTING.md](CONTRIBUTING.md).

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

Operator signatures ship from `@bifrostwallet/assets/signatures`, so a normal import does not download them. Some listings stay unsigned until 31 December 2026 (date to be confirmed with the provider community). Curator fields such as `listed` sit outside the signature. An unknown chain throws. A missing provider or signature returns an empty array.

The signature is EIP-712 (`eth_signTypedData_v4`) over `ProviderListing`, self-signed by the identity address. Changing any signed field needs a new signature. `logoHash` is the SHA-256 of `logo.webp`: 64 lowercase hex characters, with no `0x` prefix.

**Domain**

| Field | Value |
| --- | --- |
| `name` | `"Bifrost Assets"` |
| `version` | `"1"` |
| `chainId` | The id in `eip155-<id>`. Flare is 14. Songbird is 19. |
| `salt` | `EIP712_DOMAIN_SALT`, the precomputed `keccak256` of the UTF-8 string `https://bifrostwallet.com` |

```typescript
import { verifyTypedData } from "viem";
import { getProviderListingVerification } from "@bifrostwallet/assets/signatures";

const [entry] = getProviderListingVerification(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
await verifyTypedData(entry); // true
```

`EIP712_DOMAIN_SALT`, `PROVIDER_LISTING_TYPES`, `PROVIDER_LISTING_PRIMARY_TYPE`, and `providerListingTypedData({ message, chain })` are exported from `@bifrostwallet/assets` for anyone building the typed data themselves.

## jsDelivr all.json (Legacy)

Fetch provider `all.json` from jsDelivr on `@main` when you are not installing the package. `logoURL` in that file is already absolute and uses the same `@main` snapshot. There is no token `all.json`. Token lists are not published that way; use `createAssets`.

`@main` is the moving catalog, not a release tag. Provider `all.json` logo URLs in this repository use that unpinned branch. Updates there can take up to 12 hours to appear because jsDelivr caches branch URLs for up to 12 hours ([Caching](https://www.jsdelivr.com/documentation#id-caching)). The npm package pins `@<version>` (`@1.1.0` for this release) so its logos match the installed snapshot.

Compared with the package and logos you host:

- No version pin. The URL is `@main`, so changes arrive unannounced and can break you.
- List and logo requests from your users go to jsDelivr.
- Providers and their validator NodeIDs only. No tokens, contracts, dapps, or dapp categories.
- No TypeScript types, and no helpers for lookups, listed filters, or finding a provider from a validator.
- No signature checks. Those ship on `@bifrostwallet/assets/signatures`.

1. Fetch `https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/providers/<chain>/all.json`. The chain directory uses a hyphen, such as `eip155-14` (Flare) or `eip155-19` (Songbird).
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
