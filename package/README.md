# @bifrostwallet/assets

Curated catalog of [FTSO](https://github.com/bifrostwallet/assets/blob/main/README.md#glossary) providers, validators, tokens, contracts and dapps for Bifrost Wallet.

Chain ids are [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) (`eip155:14`, `eip155:19`). Pin one version and commit the lockfile.

## Install

```bash
npm install @bifrostwallet/assets@<version> --save-exact
```

Yarn: `yarn add @bifrostwallet/assets@<version> --exact`. pnpm: `pnpm add @bifrostwallet/assets@<version> --save-exact`.

## Listed providers

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
//     ...
//   },
//   ...
// ]
```

## Listed validators

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

## Validators for one identity

```typescript
import { createAssets } from "@bifrostwallet/assets";

const assets = createAssets({
  baseURL: "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.7-beta/data/",
});
const own = assets.getValidatorsByIdentity(
  "eip155:14",
  "0x1650d2760baee638c034200dedcbe17b050d0364",
);
// [
//   {
//     nodeId: "NodeID-5oLazJm5PtV8JFb2GpzuCVMZdi1GxkwYP",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     name: "Bifrost Wallet",
//   },
//   // ...
// ]
```

Logo hosting, GitHub raw `all.json`, and the rest of the lookup guide are in [CONSUMERS.md](https://github.com/bifrostwallet/assets/blob/main/CONSUMERS.md).
