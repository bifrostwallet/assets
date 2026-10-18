import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import { DAPP_CATEGORIES, DAPP_INFO_KEYS, type DappInfo } from "../src/config.js";
import { dappSlugFromUrl, networkPathToCaip2 } from "../src/convert.js";
import { isValidDescription, isValidName, isValidURL } from "../src/validate.js";

// Tests run from dist/test; process.cwd() is the repo root under `./yarn test`.
const DAPPS_DIR = path.join(process.cwd(), "data/dapps");

const VALID_CAIP2 = new Set(
  ["eip155-14", "eip155-19", "xrpl-0"].map((networkPath) => networkPathToCaip2(networkPath)),
);

function getDappSlugs(): string[] {
  return fs
    .readdirSync(DAPPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readDappInfo(slug: string): DappInfo {
  const infoPath = path.join(DAPPS_DIR, slug, "info.json");
  return JSON.parse(fs.readFileSync(infoPath, "utf8")) as DappInfo;
}

describe("curated dapps", () => {
  const slugs = getDappSlugs();
  const folderDapps = slugs.map((slug) => ({ slug, info: readDappInfo(slug) }));

  test("every dapp folder has info.json", () => {
    for (const slug of slugs) {
      const infoPath = path.join(DAPPS_DIR, slug, "info.json");
      assert.equal(fs.existsSync(infoPath), true);
    }
  });

  test("info.json entries match the DappInfo schema", () => {
    for (const { slug, info } of folderDapps) {
      assert.deepEqual(Object.keys(info).sort(), [...DAPP_INFO_KEYS].sort());

      assert.equal(isValidName(info.title), true);
      assert.equal(isValidDescription(info.description), true);
      assert.equal(isValidURL(info.url, "website"), true);
      assert.equal(info.logoURL, `dapps/${slug}/logo.webp`);
      assert.match(info.logoHash, /^[0-9a-f]{64}$/);
      const logoPath = path.join(DAPPS_DIR, slug, "logo.webp");
      assert.equal(fs.existsSync(logoPath), true);
      const logoHash = createHash("sha256").update(fs.readFileSync(logoPath)).digest("hex");
      assert.equal(info.logoHash, logoHash);
      assert.ok(Array.isArray(info.chains));
      assert.ok(info.chains.length > 0);
      for (const chain of info.chains) {
        assert.equal(VALID_CAIP2.has(chain), true);
      }
      assert.equal(DAPP_CATEGORIES.includes(info.category), true);
      assert.equal(typeof info.featured, "boolean");
      assert.equal(dappSlugFromUrl(info.url), slug);
    }
  });

  test("dapp slugs and URLs are unique", () => {
    const urls = folderDapps.map(({ info }) => info.url);
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(new Set(slugs).size, slugs.length);
  });

  test("dapps have no all.json aggregate", () => {
    assert.equal(fs.existsSync(path.join(DAPPS_DIR, "all.json")), false);
  });

  test("logo.webp is valid when present", () => {
    for (const slug of slugs) {
      const logoPath = path.join(DAPPS_DIR, slug, "logo.webp");
      if (fs.existsSync(logoPath)) {
        assert.equal(logoPath.toLowerCase().endsWith(".webp"), true);
        assert.ok(fs.statSync(logoPath).size > 0);
      }
    }
  });
});
