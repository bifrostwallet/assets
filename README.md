# @bifrostwallet/assets

Curated catalog of [FTSO](#glossary) providers, validators, tokens, contracts and dapps for Bifrost Wallet.

**Using the catalog (npm package or all.json):** [CONSUMERS.md](CONSUMERS.md).

**Adding or listing something (providers, tokens, dapps):** [CONTRIBUTING.md](CONTRIBUTING.md).

The listing form and intake API run outside this repository. Contact details stay on private intake objects. Security reports go to **security@bifrostwallet.com**. See [SECURITY.md](SECURITY.md).

## Ownership signatures

Every provider entry carries a `signatures.json` proving control of the identity address. The requirement is a self-signature by that address: EIP-712 (`eth_signTypedData_v4`) over `ProviderListing`.

The domain is `name` `"Bifrost Assets"`, `version` `"1"`, `chainId` (the id in `eip155-<id>`; Flare is 14, Songbird is 19), and `salt` `keccak256` of the UTF-8 string `https://bifrostwallet.com` (`0xffc5336f20c2026b0f53d269def3cdffa3ca99b07e238af05f263a89517104f7`). The example below uses Flare's chain id.

```json
{
  "domain": {
    "name": "Bifrost Assets",
    "version": "1",
    "chainId": 14,
    "salt": "0xffc5336f20c2026b0f53d269def3cdffa3ca99b07e238af05f263a89517104f7"
  },
  "primaryType": "ProviderListing",
  "types": {
    "ProviderListing": [
      { "name": "name", "type": "string" },
      { "name": "description", "type": "string" },
      { "name": "websiteURL", "type": "string" },
      { "name": "logoHash", "type": "bytes32" },
      { "name": "identityAddress", "type": "address" },
      { "name": "linksJson", "type": "string" },
      { "name": "acknowledgedResponsibilities", "type": "bool" },
      { "name": "contentHash", "type": "bytes32" }
    ]
  },
  "message": {
    "name": "Example",
    "description": "Example provider",
    "websiteURL": "https://example.com",
    "logoHash": "0x<64 lowercase hex chars>",
    "identityAddress": "0x<40 lowercase hex chars>",
    "linksJson": "{\"x\":\"https://x.com/example\"}",
    "acknowledgedResponsibilities": true,
    "contentHash": "0x<64 lowercase hex chars>"
  }
}
```

`logoHash` is the SHA-256 of the stored `logo.webp` bytes, as 64 lowercase hex characters. The typed-data field is that digest with a `0x` prefix.

`messageHash` in `signatures.json` and `contentHash` are the same value: `0x` plus the SHA-256 of one canonical JSON string. That string is `JSON.stringify` of these keys, in order: `name`, `description`, `logoHash` (the unprefixed hex), `websiteURL`, `links`, `identityAddress`, `acknowledgedResponsibilities`. `links` includes only the links you set, with keys in this order: `github`, `x`, `discord`, `telegram`, `youtube`, `reddit`, `linkedin`, `tiktok`. `linksJson` is `JSON.stringify` of that same `links` object, and the typed-data `contentHash` is `messageHash` as `bytes32`.

Changing any of these fields needs a new signature. Fields outside this list are unsigned and can change without a new signature, including on-chain data refreshed on a schedule.

CI checks every signature with `./yarn verify:providers`. Listings are checked again in this repository before they go live. Entries that predate the public launch stay listed through the date in [Grandfathering](CONTRIBUTING.md#grandfathering).

## Building and releasing

1. Run `./yarn build:package`. It writes `dist/` without logo files. Provider signatures are published on `@bifrostwallet/assets/signatures`, and the main entry does not load that subpath. The file npm shows is [`package/README.md`](package/README.md).
2. The published package has no runtime dependencies. The build fails if `dist/package.json` declares any.
3. Dev dependencies are pinned to exact versions and are not shipped.
4. A GitHub Release tagged `v` plus the package version stages the package through npm Trusted Publishing, with provenance, under the beta tag.
5. A maintainer approves the staged version on npmjs.com. Confirm provenance on the [npm version page](https://docs.npmjs.com/viewing-package-provenance/).

## Development

### Catalog refresh

The nightly refresh checks both domain-linkage methods and sets unsigned `domainLinked` when at least one matches and the two do not contradict for this identity. It reads the FTSO fee from `WNatDelegationFee.getVoterCurrentFeePercentage` (basis points, through `FlareContractRegistry`) and Flare validator fees from `platform.getCurrentValidators`. A Flare validator counts as currently validating when its NodeID is still returned for that provider. Providers whose [FSP](#glossary) rewards are burned (`eligibleForReward: false` in the latest `passes.json`), operators over the delegation-fee cap, and chain-drift updates are proposed together on the `nightly/fsp-delist` pull request. A curator merges that pull request.

### Working in this repository

Use the repo [`yarn`](yarn) wrapper (`./yarn`). CI sets `COREPACK_ENABLE=0`. Upgrade Yarn with `./yarn security:yarn-binary:upgrade <version>`.

1. Run `./yarn install` to install dependencies.
2. Make your changes.
3. Run `./yarn lint && ./yarn test` (`./yarn lint:fix` applies the automatic fixes) and keep the tests passing.
4. Maintainers push reviewed changes directly to `main`.

## Glossary

| Term | Meaning |
| --- | --- |
| [FTSO](https://dev.flare.network/ftso/overview) | Flare Time Series Oracle, the price feeds a provider submits. |
| [FSP](https://dev.flare.network/network/fsp) | Flare Systems Protocol, which records provider rewards and participation. |
| [FDC](https://dev.flare.network/fdc/overview) | Flare Data Connector, the attestation service a provider runs. |
| P-chain | The staking chain where a Flare validator is currently validating. |
| NodeID | A validator id, stored with the `NodeID-` prefix. |
| Identity address | The on-chain address that owns a provider and signs its listing. |
| Vote power | WFLR or WSGB weight delegated to a provider. |
| [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/master/CAIPs/caip-2.md) | Chain id form used by the package, such as `eip155:14`. |
| [EIP-155](https://eips.ethereum.org/EIPS/eip-155) | The `eip155` namespace in those chain ids. |
| [EIP-712](https://eips.ethereum.org/EIPS/eip-712) | Typed-data signing used for a provider listing. |
