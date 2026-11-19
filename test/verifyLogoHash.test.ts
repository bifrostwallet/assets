import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
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
    const example = logoExample(readme);
    assert.match(
      example,
      /import \{ createAssets, verifyLogoHash \} from "@bifrostwallet\/assets";/,
    );
    assert.match(example, /createAssets\(\{ baseURL: "https:\/\/assets\.example\.com\/" \}\)/);
    assert.match(
      example,
      /assets\.getProvider\(\s*"eip155:14",\s*"0x1650d2760baee638c034200dedcbe17b050d0364",\s*\)/,
    );
    assert.match(example, /const response = await fetch\(entry\.logoURL\);/);
    assert.match(example, /if \(!response\.ok\)/);
    assert.match(example, /const bytes = new Uint8Array\(await response\.arrayBuffer\(\)\);/);
    assert.match(example, /bytes\.byteLength > 256 \* 1024/);
    assert.match(
      example,
      /if \(!verifyLogoHash\(bytes, entry\.logoHash\)\) throw new Error\("logo hash mismatch"\)/,
    );
    assert.match(example, /Display or cache the image only after the hash matches/);
    assert.match(
      readme,
      /Hash the original bytes, not a transcoded or resized image \(image proxies and CDN optimizers change bytes\), and don't use `response\.text\(\)` or a blob URL round-trip that alters bytes\./,
    );
    assert.equal(example.includes("fetchLogo"), false);
  });

  test("the README example verifies a real catalog logo", () => {
    const example = logoExample(fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8"));
    const { createAssets } = published as {
      createAssets: () => {
        getProvider: (
          chainId: string,
          identityAddress: string,
        ) => { logoURL: string; logoHash: string } | null;
      };
    };
    const entry = createAssets().getProvider(
      "eip155:14",
      "0x1650d2760baee638c034200dedcbe17b050d0364",
    );
    assert.ok(entry);
    assert.match(
      entry.logoURL,
      /^https:\/\/cdn\.jsdelivr\.net\/gh\/bifrostwallet\/assets@[^/]+\/data\//,
    );
    assert.match(entry.logoHash, /^[0-9a-f]{64}$/);
    const relative = entry.logoURL.slice(entry.logoURL.indexOf("/data/") + "/data/".length);
    const logoPath = path.resolve(process.cwd(), "data", relative);
    const dataRoot = path.resolve(process.cwd(), "data");
    assert.equal(logoPath.startsWith(`${dataRoot}${path.sep}`), true);
    const expected = fs.readFileSync(logoPath);
    assert.equal(expected.byteLength <= 256 * 1024, true);
    assert.equal(verifyFromPackage(expected, entry.logoHash), true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logo-example-"));
    try {
      const runnerPath = path.join(dir, "run.mjs");
      const outPath = path.join(dir, "bytes.bin");
      const body = example.replace(/^import .*\n/, "");
      const indexUrl = pathToFileURL(path.join(process.cwd(), "dist", "index.js")).href;
      fs.writeFileSync(
        runnerPath,
        `import fs from "node:fs";
import path from "node:path";
import pkg from ${JSON.stringify(indexUrl)};
const { createAssets, verifyLogoHash } = pkg;

const dataRoot = ${JSON.stringify(dataRoot)};
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const marker = "/data/";
  const idx = url.pathname.indexOf(marker);
  if (idx === -1) throw new Error("unexpected logo URL");
  const relative = decodeURIComponent(url.pathname.slice(idx + marker.length));
  const filePath = path.resolve(dataRoot, relative);
  if (!filePath.startsWith(dataRoot + path.sep)) throw new Error("logo path escapes data/");
  return new Response(fs.readFileSync(filePath));
};

${body}
fs.writeFileSync(${JSON.stringify(outPath)}, bytes);
`,
      );
      const run = spawnSync(process.execPath, [runnerPath], { encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      assert.deepEqual(fs.readFileSync(outPath), expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function logoExample(readme: string): string {
  const heading = "### Optional: check a downloaded logo";
  const start = readme.indexOf(heading);
  assert.notEqual(start, -1);
  const next = readme.indexOf("\n### ", start + heading.length);
  const section = readme.slice(start, next === -1 ? undefined : next);
  const fence = section.match(/```ts\r?\n([\s\S]*?)```/);
  assert.ok(fence?.[1]);
  return fence[1];
}
