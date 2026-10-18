import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  DAPP_CATEGORIES,
  DAPP_CATEGORY_LABELS,
  DAPP_CHAIN_IDS,
  DAPP_INFO_KEYS,
  type DappCategory,
  type DappInfo,
} from "../src/config.js";
import { dappSlugFromUrl } from "../src/convert.js";
import {
  type DappCategoryGroup,
  dappCategoryErrors,
  readDappCategories,
  validateDappCategories,
} from "../src/dappCategories.js";
import { convertDappLogoPng } from "../src/dappLogo.js";
import { isValidDescription, isValidImage, isValidName, isValidURL } from "../src/validate.js";

// Tests run from dist/test; process.cwd() is the repo root under `./yarn test`.
const DAPPS_DIR = path.join(process.cwd(), "data/dapps");

const VALID_CAIP2 = new Set<string>(DAPP_CHAIN_IDS);

/** Chains confirmed from each project's own docs, kept to DAPP_CHAINS. */
const CONFIRMED_CHAINS: Record<string, readonly string[]> = {
  "au-cc": ["eip155:14", "eip155:19"],
  "bifrostwallet-com": [
    "bip122:000000000019d6689c085ae165831e93",
    "bip122:12a765e31ffd4059bada1e25190f6e98",
    "bip122:1a91e3dace36e2be3bf030a65679fe82",
    "eip155:1",
    "eip155:10",
    "eip155:137",
    "eip155:14",
    "eip155:19",
    "eip155:42161",
    "eip155:50",
    "eip155:56",
    "eip155:8453",
    "eip155:999",
    "xrpl:0",
  ],
  "blazeswap-xyz": ["eip155:14", "eip155:19"],
  "enosys-global": ["eip155:1", "eip155:14", "eip155:19", "eip155:50", "xrpl:0"],
  "firelight-finance": ["eip155:14"],
  "flare-network": ["eip155:14", "eip155:19"],
  "kinetic-market": ["eip155:14"],
  "layerzero-network": [
    "eip155:1",
    "eip155:10",
    "eip155:137",
    "eip155:14",
    "eip155:42161",
    "eip155:50",
    "eip155:56",
    "eip155:8453",
    "eip155:999",
  ],
  "morpho-org": [
    "eip155:1",
    "eip155:10",
    "eip155:137",
    "eip155:14",
    "eip155:42161",
    "eip155:8453",
    "eip155:999",
  ],
  "nortso-xyz": ["eip155:14", "eip155:19"],
  "oracle-daemon-com": ["eip155:14", "eip155:19"],
  "sparkdex-ai": ["eip155:14"],
  "spectra-finance": [
    "eip155:1",
    "eip155:10",
    "eip155:14",
    "eip155:42161",
    "eip155:56",
    "eip155:8453",
    "eip155:999",
  ],
  "stargate-finance": [
    "eip155:1",
    "eip155:10",
    "eip155:137",
    "eip155:14",
    "eip155:42161",
    "eip155:50",
    "eip155:56",
    "eip155:8453",
  ],
  "tsoatlas-xyz": ["eip155:14", "eip155:19"],
};

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
      assert.equal("category" in info, false);
      assert.equal("featured" in info, false);
      assert.equal(dappSlugFromUrl(info.url), slug);
      assert.deepEqual(info.chains, CONFIRMED_CHAINS[slug]);
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

  test("categories.json is the hand-ordered browser chip list", () => {
    const categories = readDappCategories() as DappCategoryGroup[];
    assert.deepEqual(
      categories.map((group) => group.id),
      [...DAPP_CATEGORIES],
    );
    assert.deepEqual(
      categories.map((group) => group.label),
      DAPP_CATEGORIES.map((id) => DAPP_CATEGORY_LABELS[id]),
    );
    assert.deepEqual(
      categories.map((group) => group.dapps),
      [
        ["sparkdex-ai", "firelight-finance"],
        ["sparkdex-ai", "blazeswap-xyz", "enosys-global"],
        ["kinetic-market", "morpho-org", "enosys-global"],
        ["spectra-finance", "enosys-global"],
        ["firelight-finance", "au-cc"],
        ["enosys-global"],
        [],
        [],
      ],
    );
    for (const group of categories) {
      assert.deepEqual(Object.keys(group).sort(), ["dapps", "id", "label"]);
    }
  });

  test("category validation reports only dapps that fit no chip", () => {
    const errors = validateDappCategories();
    const uncategorized = errors.filter((error) => error.includes("is in no category"));
    assert.deepEqual(
      errors.filter((error) => !error.includes("is in no category")),
      [],
    );
    assert.deepEqual(uncategorized, [
      "dapp bifrostwallet-com is in no category",
      "dapp flare-network is in no category",
      "dapp layerzero-network is in no category",
      "dapp nortso-xyz is in no category",
      "dapp oracle-daemon-com is in no category",
      "dapp stargate-finance is in no category",
      "dapp tsoatlas-xyz is in no category",
    ]);
  });
});

function chips(overrides: Partial<Record<DappCategory, string[]>> = {}): DappCategoryGroup[] {
  return DAPP_CATEGORIES.map((id) => ({
    id,
    label: DAPP_CATEGORY_LABELS[id],
    dapps: overrides[id] ?? [],
  }));
}

describe("dapp category rules", () => {
  test("fails when a slug is missing, unknown, repeated, or the id is not allowed", () => {
    const missing = dappCategoryErrors(chips({ dex: ["sparkdex-ai"] }), ["sparkdex-ai", "au-cc"]);
    assert.deepEqual(missing, ["dapp au-cc is in no category"]);

    const unknown = dappCategoryErrors(chips({ dex: ["missing-dapp"] }), []);
    assert.deepEqual(unknown, ["slug missing-dapp in dex does not exist"]);

    const repeated = dappCategoryErrors(chips({ dex: ["sparkdex-ai", "sparkdex-ai"] }), [
      "sparkdex-ai",
    ]);
    assert.deepEqual(repeated, ["slug sparkdex-ai repeats within dex"]);

    const badId = chips();
    badId[1] = { id: "nft" as DappCategory, label: "NFT", dapps: [] };
    const bad = dappCategoryErrors(badId, []);
    assert.ok(bad.some((error) => error.includes("not an allowed category")));

    const swapped = chips();
    const dex = swapped[1];
    swapped[1] = swapped[2];
    swapped[2] = dex;
    const swappedErrors = dappCategoryErrors(swapped, []);
    assert.ok(swappedErrors.some((error) => error === "categories[1] id must be dex"));

    const filtered = chips();
    (filtered[0] as DappCategoryGroup & { network?: string }).network = "eip155:14";
    const extra = dappCategoryErrors(filtered, []);
    assert.ok(extra.some((error) => error.includes("keys must be id, label, dapps")));
  });
});

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("dapp logo conversion", () => {
  test("converts a PNG to catalog WebP and rejects a non-PNG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dapp-logo-"));
    const pngPath = path.join(dir, "logo.png");
    fs.writeFileSync(pngPath, ONE_PIXEL_PNG);
    const webp = convertDappLogoPng(pngPath);
    assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP");
    const webpPath = path.join(dir, "logo.webp");
    fs.writeFileSync(webpPath, webp);
    const validation = isValidImage(webpPath);
    assert.equal(validation.isValid, true, validation.errors.join("; "));

    const textPath = path.join(dir, "not-a-logo.png");
    fs.writeFileSync(textPath, "not a png");
    assert.throws(() => convertDappLogoPng(textPath), /Logo must be a PNG file/);
  });
});
