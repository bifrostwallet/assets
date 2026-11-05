# Consuming assets

Install [`@bifrostwallet/assets`](https://www.npmjs.com/package/@bifrostwallet/assets) and version-lock it. The package is audited and has zero runtime dependencies. Read listings from that package. Do not fetch `all.json`, or any other catalog JSON, from GitHub, a CDN, or the web.

```js
import { getProvider, getListedProviders, resolveAssetURL } from "@bifrostwallet/assets";

const listed = getListedProviders("eip155:14");
const provider = getProvider("eip155:14", "0x1650d2760baee638c034200dedcbe17b050d0364");
```

Show `listed: true` providers in pickers (`getListedProviders`). Show any provider in confirmations and details (`getProvider`).

## Logos

Do not load icons from GitHub or from Bifrost's CDN. `logoURL` is a relative path such as `providers/eip155-14/<identity>/logo.webp`. The same field exists on other listings (tokens, dapps); `resolveAssetURL` works for all of them. Pass a base you control (your CDN or your backend) and host the files at that same path:

```js
const logoURL = resolveAssetURL(provider.logoURL, "https://cdn.example.com/assets/");
```

After install, upload the package's `providers/**/logo.webp` files to that host, keeping the relative paths.

Provider listing rules for operators are in [README.md](README.md) and at [docs.bifrostwallet.com/list/ftso-provider](https://docs.bifrostwallet.com/list/ftso-provider).
