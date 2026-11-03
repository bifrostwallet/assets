import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
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
    decimals: 6,
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

  test("rejects an address field, an AMM code, a bad folder, and decimals outside 0-15", () => {
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
      validateXrplToken(rlusdInfo({ decimals: 16 }), RLUSD_ISSUER, RLUSD_CURRENCY).some((error) =>
        error.includes("0 through 15"),
      ),
    );
    assert.ok(
      validateXrplToken(rlusdInfo({ decimals: -1 }), RLUSD_ISSUER, RLUSD_CURRENCY).some((error) =>
        error.includes("0 through 15"),
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
    );
    const sorted = [...entries].sort(
      (a, b) => a.issuer.localeCompare(b.issuer) || a.currency.localeCompare(b.currency),
    );
    assert.deepEqual(all, sorted);
  });
});
