import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { listTokenChainPaths, loadTokenInfo, type TokenInfo } from "../src/tokens.js";
import { isValidImage } from "../src/validate.js";
import {
  decodeXrplCurrency,
  isValidXrplAccountAddress,
  validateXrplIouInfo,
  XRPL_MAINNET_CHAIN_PATH,
  xrplIouKey,
} from "../src/xrplToken.js";

const RLUSD_ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
const RLUSD_CURRENCY = "524C555344000000000000000000000000000000";

describe("XRPL issued-token keys", () => {
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

  test("the IOU key is issuer.currency in exact case", () => {
    assert.equal(xrplIouKey(RLUSD_ISSUER, RLUSD_CURRENCY), `${RLUSD_ISSUER}.${RLUSD_CURRENCY}`);
  });
});

describe("XRPL mainnet catalog", () => {
  const chainDir = path.join(process.cwd(), "data", "tokens", XRPL_MAINNET_CHAIN_PATH);

  test("xrpl-0 is a token chain and every entry matches its folder", () => {
    assert.ok(listTokenChainPaths().includes(XRPL_MAINNET_CHAIN_PATH));
    const dirs = fs
      .readdirSync(chainDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.ok(dirs.length > 0);

    const entries: TokenInfo[] = [];
    for (const dirName of dirs) {
      const dir = path.join(chainDir, dirName);
      const infoPath = path.join(dir, "info.json");
      const logoPath = path.join(dir, "logo.webp");
      const info = loadTokenInfo(infoPath);
      const logo = fs.readFileSync(logoPath);
      const logoSha256 = createHash("sha256").update(logo).digest("hex");
      const errors = validateXrplIouInfo(info, dirName, logoSha256);
      assert.deepEqual(errors, [], `${dirName}: ${errors.join("; ")}`);
      const image = isValidImage(logoPath);
      assert.equal(image.isValid, true, `${dirName}: ${(image.errors ?? []).join("; ")}`);
      entries.push(info);
    }

    const all = JSON.parse(fs.readFileSync(path.join(chainDir, "all.json"), "utf8"));
    const sorted = [...entries].sort((a, b) => String(a.address).localeCompare(String(b.address)));
    assert.deepEqual(all, sorted);
  });
});
