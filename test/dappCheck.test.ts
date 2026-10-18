import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { DAPP_CATEGORIES, DAPP_CATEGORY_LABELS, type DappCategory } from "../src/config.js";
import { checkDappCatalog } from "../src/dappCheck.js";
import { sha256Hex } from "../src/manifest.js";

const SCRIPT = path.join(process.cwd(), "build/src/script/checkDapps.js");

/** Minimal VP8L WebP. Dimension checks do not decode the bitstream. */
function webp(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(bits, 1);
  const chunk = Buffer.concat([Buffer.from("VP8L"), Buffer.from([5, 0, 0, 0]), data]);
  const payload = Buffer.concat([Buffer.from("WEBP"), chunk]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length, 0);
  return Buffer.concat([Buffer.from("RIFF"), size, payload]);
}

function writeCategories(
  root: string,
  membership: Partial<Record<DappCategory, string[]>> = {},
): void {
  const categories = DAPP_CATEGORIES.map((id) => ({
    id,
    label: DAPP_CATEGORY_LABELS[id],
    dapps: membership[id] ?? [],
  }));
  fs.mkdirSync(path.join(root, "data", "dapps"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "dapps", "categories.json"),
    `${JSON.stringify(categories, null, 2)}\n`,
  );
}

function writeDapp(
  root: string,
  slug: string,
  logo: Buffer,
  overrides: Record<string, unknown> = {},
): string {
  const logoHash = sha256Hex(logo);
  const dir = path.join(root, "data", "dapps", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "logo.webp"), logo);
  const info = {
    title: "Example",
    description: "A valid catalog description.",
    url: "https://example.com",
    logoURL: `dapps/${slug}/logo.webp`,
    logoHash,
    chains: ["eip155:14"],
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return logoHash;
}

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dapp-check-"));
}

function validRoot(): { root: string; logoHash: string } {
  const root = fixture();
  const logoHash = writeDapp(root, "example-com", webp(128, 128));
  writeCategories(root, { other: ["example-com"] });
  return { root, logoHash };
}

describe("check:dapps", () => {
  test("the curated catalog has no errors or uncategorized warnings", () => {
    const result = checkDappCatalog();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test("fails on schema violations", () => {
    const root = fixture();
    writeDapp(root, "example-com", webp(128, 128), {
      title: " x",
      description: "short",
      url: "http://example.com",
      logoURL: "https://example.com/logo.png",
      logoHash: "ABCDEF",
      chains: ["not-a-chain"],
    });
    writeCategories(root, { other: ["example-com"] });
    const { errors } = checkDappCatalog(root);
    assert.ok(errors.some((error) => error.includes("title is invalid")));
    assert.ok(errors.some((error) => error.includes("description is invalid")));
    assert.ok(errors.some((error) => error.includes("url must be https")));
    assert.ok(errors.some((error) => error.includes("logoURL must be")));
    assert.ok(errors.some((error) => error.includes("logoHash must be")));
    assert.ok(errors.some((error) => error.includes("not an allowed CAIP-2 chain")));
  });

  test("fails when logo.webp is missing, not WebP, the wrong size, or a different hash", () => {
    const missing = fixture();
    writeDapp(missing, "example-com", webp(128, 128));
    fs.unlinkSync(path.join(missing, "data", "dapps", "example-com", "logo.webp"));
    writeCategories(missing, { other: ["example-com"] });
    assert.ok(
      checkDappCatalog(missing).errors.some((error) => error.includes("logo.webp is missing")),
    );

    const png = fixture();
    writeDapp(png, "example-com", webp(128, 128));
    fs.writeFileSync(path.join(png, "data", "dapps", "example-com", "logo.webp"), "not webp");
    writeCategories(png, { other: ["example-com"] });
    assert.ok(checkDappCatalog(png).errors.some((error) => error.includes("logo must be WebP")));

    const small = fixture();
    writeDapp(small, "example-com", webp(1, 1));
    writeCategories(small, { other: ["example-com"] });
    assert.ok(
      checkDappCatalog(small).errors.some((error) => error.includes("less than minimum required")),
    );

    const drifted = fixture();
    writeDapp(drifted, "example-com", webp(128, 128), { logoHash: "a".repeat(64) });
    writeCategories(drifted, { other: ["example-com"] });
    assert.ok(
      checkDappCatalog(drifted).errors.some((error) =>
        error.includes("logoHash does not match logo.webp"),
      ),
    );
  });

  test("fails on an unknown slug, a duplicate within a chip, or an unknown category id", () => {
    const unknown = fixture();
    writeDapp(unknown, "example-com", webp(128, 128));
    writeCategories(unknown, { dex: ["missing-dapp"], other: ["example-com"] });
    assert.ok(
      checkDappCatalog(unknown).errors.some((error) =>
        error.includes("slug missing-dapp in dex does not exist"),
      ),
    );

    const duplicate = fixture();
    writeDapp(duplicate, "example-com", webp(128, 128));
    writeCategories(duplicate, { other: ["example-com", "example-com"] });
    assert.ok(
      checkDappCatalog(duplicate).errors.some((error) =>
        error.includes("slug example-com repeats within other"),
      ),
    );

    const badId = fixture();
    writeDapp(badId, "example-com", webp(128, 128));
    writeCategories(badId, { other: ["example-com"] });
    const categoriesPath = path.join(badId, "data", "dapps", "categories.json");
    const categories = JSON.parse(fs.readFileSync(categoriesPath, "utf8")) as { id: string }[];
    categories[1].id = "nft";
    fs.writeFileSync(categoriesPath, `${JSON.stringify(categories, null, 2)}\n`);
    assert.ok(
      checkDappCatalog(badId).errors.some((error) => error.includes("not an allowed category")),
    );
  });

  test("fails when a contract dapp slug is missing or its logoHash differs", () => {
    const { root, logoHash } = validRoot();
    const chainDir = path.join(root, "data", "contracts", "eip155-14");
    fs.mkdirSync(chainDir, { recursive: true });
    const filePath = path.join(chainDir, "0x1111111111111111111111111111111111111111.json");
    fs.writeFileSync(filePath, `${JSON.stringify({ dapp: "missing-dapp", logoHash }, null, 2)}\n`);
    assert.ok(
      checkDappCatalog(root).errors.some((error) =>
        error.includes("dapp slug missing-dapp does not exist"),
      ),
    );

    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ dapp: "example-com", logoHash: "b".repeat(64) }, null, 2)}\n`,
    );
    const drifted = checkDappCatalog(root);
    assert.ok(
      drifted.errors.some((error) => error.includes("logoHash differs from dapp example-com")),
    );
    assert.deepEqual(drifted.warnings, []);

    fs.writeFileSync(filePath, `${JSON.stringify({ dapp: "example-com", logoHash }, null, 2)}\n`);
    assert.deepEqual(checkDappCatalog(root).errors, []);
  });

  test("warns and does not fail when a dapp is in no category", () => {
    const root = fixture();
    writeDapp(root, "example-com", webp(128, 128));
    writeCategories(root);
    const result = checkDappCatalog(root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, ["dapp example-com is in no category"]);
  });

  test("the script exits 1 on errors and 0 on an uncategorized warning", () => {
    const broken = fixture();
    writeDapp(broken, "example-com", webp(128, 128), { url: "http://example.com" });
    writeCategories(broken, { other: ["example-com"] });
    const failed = spawnSync(process.execPath, [SCRIPT], { cwd: broken, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /url must be https/);

    const warning = fixture();
    writeDapp(warning, "example-com", webp(128, 128));
    writeCategories(warning);
    const warned = spawnSync(process.execPath, [SCRIPT], { cwd: warning, encoding: "utf8" });
    assert.equal(warned.status, 0);
    assert.match(warned.stderr, /dapp example-com is in no category/);
    assert.match(warned.stdout, /Dapp catalog valid/);
  });
});
