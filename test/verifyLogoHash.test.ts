import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

const GOOD = Buffer.from("webp-bytes-for-the-hash-check");
const GOOD_HASH = createHash("sha256").update(GOOD).digest("hex");

interface LogoModule {
  verifyLogoHash: (bytes: Uint8Array | ArrayBuffer, expectedHash: string) => boolean;
}

const SHIPPED_CODE = [
  "index.js",
  "index.d.ts",
  "verify-logo-hash.js",
  "signatures.js",
  "signatures.d.ts",
];

describe("verifyLogoHash", { concurrency: false }, () => {
  let releaseDist: (() => void) | undefined;
  let logos: LogoModule;
  let verifyFromPackage: LogoModule["verifyLogoHash"];
  let published: Record<string, unknown>;

  before(() => {
    releaseDist = holdPackageDist();
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const hashPath = path.join(process.cwd(), "dist", "verify-logo-hash.js");
    logos = require(hashPath) as LogoModule;
    const indexPath = path.join(process.cwd(), "dist", "index.js");
    delete require.cache[indexPath];
    published = require(indexPath) as Record<string, unknown>;
    verifyFromPackage = published.verifyLogoHash as LogoModule["verifyLogoHash"];
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", "fetch-logos.js")), false);
  });

  after(() => {
    releaseDist?.();
  });

  test("verifyLogoHash accepts the catalog digest and rejects anything else", () => {
    assert.equal(verifyFromPackage(GOOD, GOOD_HASH), true);
    assert.equal(logos.verifyLogoHash(GOOD, GOOD_HASH), true);
    assert.equal(verifyFromPackage(Buffer.from("other"), GOOD_HASH), false);
    assert.equal(verifyFromPackage(GOOD, "0".repeat(64)), false);
    assert.equal(verifyFromPackage(GOOD, `0x${GOOD_HASH}`), false);
    assert.equal(verifyFromPackage(GOOD, ""), false);
    assert.equal(verifyFromPackage(GOOD, GOOD_HASH.slice(0, 63)), false);
  });

  test("verifyLogoHash accepts a catalog logo file", () => {
    const rows = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "dist", "providers", "eip155-14.json"), "utf8"),
    ) as Array<{ logoURL: string; logoHash: string }>;
    const entry = rows.find((row) =>
      row.logoURL.includes("0x1650d2760baee638c034200dedcbe17b050d0364"),
    );
    assert.ok(entry);
    const bytes = fs.readFileSync(path.join(process.cwd(), "data", entry.logoURL));
    assert.equal(verifyFromPackage(bytes, entry.logoHash), true);
    assert.equal(logos.verifyLogoHash(Buffer.from("not-the-logo"), entry.logoHash), false);
  });

  test("the package does not export fetchLogo or ship network code", () => {
    assert.equal("fetchLogo" in published, false);
    assert.equal("fetchLogo" in logos, false);
    const distDir = path.join(process.cwd(), "dist");
    for (const name of SHIPPED_CODE) {
      const source = fs.readFileSync(path.join(distDir, name), "utf8");
      const networkCode = /\bfetch\b|fetchLogo|XMLHttpRequest|\bWebSocket\b|node:https?\b/;
      assert.equal(networkCode.test(source), false, name);
    }
    const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    assert.match(readme, /const response = await fetch\(entry\.logoURL\);/);
    assert.match(readme, /if \(!response\.ok\)/);
    assert.match(readme, /const bytes = new Uint8Array\(await response\.arrayBuffer\(\)\);/);
    assert.match(readme, /bytes\.byteLength > 256 \* 1024/);
    assert.match(
      readme,
      /if \(!verifyLogoHash\(bytes, entry\.logoHash\)\) throw new Error\("logo hash mismatch"\)/,
    );
    assert.match(readme, /fetchLogo` is removed/);
  });
});
