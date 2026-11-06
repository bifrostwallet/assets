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
import { getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const base = "https://cdn.example.com/assets/";
const listed = getListedProviders("eip155:14").map((provider) => ({
  ...provider,
  logoURL: resolveAssetURL(provider.logoURL, base),
}));
// [
//   {
//     name: "Bifrost Wallet",
//     identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364",
//     listed: true,
//     logoURL:
//       "https://cdn.example.com/assets/providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
//     ...
//   },
//   ...
// ]
```

## Listed validators

```typescript
import { getListedValidators } from "@bifrostwallet/assets";

const validators = getListedValidators("eip155:14");
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
import { getValidatorsByIdentity } from "@bifrostwallet/assets";

const own = getValidatorsByIdentity(
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
