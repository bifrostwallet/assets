import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_ASSET_BASE_URL } from "../src/config.js";
import { buildTokensAllJson } from "../src/convert.js";
import { listTokenChainPaths } from "../src/tokens.js";
import { isValidImage } from "../src/validate.js";
import {
  decodeXrplCurrency,
  isValidXrplAccountAddress,
  listXrplTokenDirs,
  validateXrplToken,
  XRPL_MAINNET_CHAIN_PATH,
  type XrplToken,
  xrplCatalogPathErrors,
} from "../src/xrplToken.js";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";

function rlusdInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Ripple USD",
    symbol: "RLUSD",
    issuer: RLUSD_ISSUER,
    currency: RLUSD_CURRENCY,
    coingeckoId: "ripple-usd",
    logoURL: `tokens/xrpl-0/${RLUSD_ISSUER}/${RLUSD_CURRENCY}/logo.webp`,
    logoHash: "a".repeat(64),
    ...overrides,
  };
}

describe("XRPL issued-token identity", () => {
  test("accepts classic r-addresses and rejects a bad checksum", () => {
    assert.equal(isValidXrplAccountAddress(RLUSD_ISSUER), true);
    assert.equal(isValidXrplAccountAddress("rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B"), true);
    assert.equal(isValidXrplAccountAddress("rsoLo2S1kiGeCcn6hCUXVrCpGMWLrRrLZz"), true);
    assert.equal(isValidXrplAccountAddress("rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5Df"), false);
    assert.equal(isValidXrplAccountAddress(RLUSD_ISSUER.toLowerCase()), false);
    assert.equal(isValidXrplAccountAddress("0x8292bb45bf1ee4d140127049757c2e0ff06317ed"), false);
  });

  test("decodes on-ledger currency codes and rejects XRP and AMM LP tokens", () => {
    assert.equal(decodeXrplCurrency("USD"), "USD");
    assert.equal(decodeXrplCurrency("BTC"), "BTC");
    assert.equal(decodeXrplCurrency(RLUSD_CURRENCY), "RLUSD");
    assert.equal(decodeXrplCurrency("534F4C4F00000000000000000000000000000000"), "SOLO");
    assert.equal(decodeXrplCurrency("XRP"), null);
    assert.equal(decodeXrplCurrency(RLUSD_CURRENCY.toLowerCase()), null);
    assert.equal(decodeXrplCurrency(`03${"AB".repeat(19)}`), null);
    assert.equal(decodeXrplCurrency(`00${"11".repeat(19)}`), null);
  });

  test("rejects an address field, a decimals key, an AMM code, and a bad folder", () => {
    const amm = `03${"AB".repeat(19)}`;
    assert.deepEqual(validateXrplToken(rlusdInfo(), RLUSD_ISSUER, RLUSD_CURRENCY), []);
    assert.ok(
      validateXrplToken(
        rlusdInfo({ address: `${RLUSD_ISSUER}.${RLUSD_CURRENCY}` }),
        RLUSD_ISSUER,
        RLUSD_CURRENCY,
      ).some((error) => error.includes("unexpected field address")),
    );
    assert.ok(
      validateXrplToken(rlusdInfo({ currency: amm, symbol: "LP" }), RLUSD_ISSUER, amm).some(
        (error) => error.includes("AMM LP"),
      ),
    );
    assert.ok(
      validateXrplToken(rlusdInfo(), "rNotTheFolderxxxxxxxxxxxxxxxxxx", RLUSD_CURRENCY).some(
        (error) => error.includes("must equal issuer"),
      ),
    );
    assert.ok(
      validateXrplToken(rlusdInfo(), RLUSD_ISSUER, "USD").some((error) =>
        error.includes("must equal currency"),
      ),
    );
    assert.ok(
      validateXrplToken(rlusdInfo({ decimals: 6 }), RLUSD_ISSUER, RLUSD_CURRENCY).some(
        (error) => error === "unexpected field decimals",
      ),
    );
  });
});

describe("XRPL mainnet catalog", () => {
  test("xrpl-0 is a token chain and every entry matches issuer/currency", () => {
    assert.ok(listTokenChainPaths().includes(XRPL_MAINNET_CHAIN_PATH));
    assert.deepEqual(xrplCatalogPathErrors(), []);
    const dirs = listXrplTokenDirs();
    assert.ok(dirs.length > 0);

    const entries: XrplToken[] = [];
    for (const { issuerDir, currencyDir, dir } of dirs) {
      const infoPath = path.join(dir, "info.json");
      const logoPath = path.join(dir, "logo.webp");
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as XrplToken;
      const logo = fs.readFileSync(logoPath);
      const logoSha256 = createHash("sha256").update(logo).digest("hex");
      const errors = validateXrplToken(info, issuerDir, currencyDir, logoSha256);
      assert.deepEqual(errors, [], `${issuerDir}/${currencyDir}: ${errors.join("; ")}`);
      assert.equal(Object.hasOwn(info, "address"), false);
      assert.equal(Object.hasOwn(info, "decimals"), false);
      assert.equal(info.issuer, issuerDir);
      assert.equal(info.currency, currencyDir);
      assert.equal(info.logoURL, `tokens/xrpl-0/${issuerDir}/${currencyDir}/logo.webp`);
      const image = isValidImage(logoPath);
      assert.equal(
        image.isValid,
        true,
        `${issuerDir}/${currencyDir}: ${(image.errors ?? []).join("; ")}`,
      );
      entries.push(info);
    }

    const all = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "data", "tokens", XRPL_MAINNET_CHAIN_PATH, "all.json"),
        "utf8",
      ),
    ) as XrplToken[];
    assert.deepEqual(all, buildTokensAllJson(XRPL_MAINNET_CHAIN_PATH));
    assert.equal(all.length, entries.length);
    for (let index = 0; index < entries.length; index += 1) {
      const info = entries[index];
      const published = all[index];
      assert.ok(info);
      assert.ok(published);
      assert.equal(published.logoURL, `${DEFAULT_ASSET_BASE_URL}${info.logoURL}`);
    }
  });
});
