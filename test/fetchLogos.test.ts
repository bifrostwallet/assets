import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

function publishedLogoURLs(distDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name === "package.json") continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object" || !("logoURL" in item)) continue;
        found.push(String((item as { logoURL: unknown }).logoURL));
      }
    }
  };
  walk(distDir);
  return found;
}

function sourceContainsHostname(source: string, hostname: string): boolean {
  for (const match of source.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    try {
      if (new URL(match[0]).hostname === hostname) return true;
    } catch {
      // The match is not a URL.
    }
  }
  return false;
}

const GOOD = Buffer.from("webp-bytes-for-the-hash-check");
const GOOD_HASH = createHash("sha256").update(GOOD).digest("hex");
const GOOD_PATH = "tokens/eip155-1/0xabc/logo.webp";
const MISSING_PATH = "tokens/eip155-1/0xdef/logo.webp";
const BAD_PATH = "providers/eip155-14/0x123/logo.webp";
const DAPP_PATH = "dapps/sparkdex-ai/logo.webp";

interface FetchLogosModule {
  fetchLogos: (options: {
    destDir: string;
    packageRoot?: string;
    baseURL?: string;
    fetch?: typeof fetch;
  }) => Promise<{ written: string[]; failures: string[] }>;
  runCli: (
    argv: string[],
    deps?: { packageRoot?: string; baseURL?: string; fetch?: typeof fetch },
  ) => Promise<number>;
  verifyLogoHash: (bytes: Uint8Array, expectedHash: string) => boolean;
}

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, "tokens"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tokens", "eip155-1.json"),
    `${JSON.stringify(
      [
        { logoURL: GOOD_PATH, logoHash: GOOD_HASH },
        { logoURL: MISSING_PATH },
        { logoURL: BAD_PATH, logoHash: GOOD_HASH },
        { logoURL: DAPP_PATH, logoHash: GOOD_HASH },
      ],
      null,
      2,
    )}\n`,
  );
}

function startServer(): Promise<{
  server: Server;
  origin: string;
  accepts: string[];
  urls: string[];
}> {
  const accepts: string[] = [];
  const urls: string[] = [];
  const server = createServer((req, res) => {
    accepts.push(String(req.headers.accept ?? ""));
    const url = req.url ?? "";
    urls.push(url);
    if (url.endsWith(BAD_PATH)) {
      res.end(Buffer.from("not-the-logo"));
      return;
    }
    if (url.endsWith("gzip.webp")) {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(GOOD));
      return;
    }
    res.end(GOOD);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, origin: `http://127.0.0.1:${address.port}/data/`, accepts, urls });
    });
  });
}

describe("fetch-logos and verifyLogoHash", { concurrency: false }, () => {
  let releaseDist: (() => void) | undefined;
  let logos: FetchLogosModule;
  let verifyFromPackage: FetchLogosModule["verifyLogoHash"];

  before(() => {
    releaseDist = holdPackageDist();
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const fetchPath = path.join(process.cwd(), "dist", "fetch-logos.js");
    logos = require(fetchPath) as FetchLogosModule;
    const indexPath = path.join(process.cwd(), "dist", "index.js");
    delete require.cache[indexPath];
    verifyFromPackage = (
      require(indexPath) as { verifyLogoHash: FetchLogosModule["verifyLogoHash"] }
    ).verifyLogoHash;
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

  test("writes a matching logo and skips a mismatch or a missing hash", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-out-"));
    writeFixture(fixture);
    const { server, origin, accepts, urls } = await startServer();
    try {
      const result = await logos.fetchLogos({
        destDir: dest,
        packageRoot: fixture,
        baseURL: origin,
        fetch,
      });
      const code = await logos.runCli([dest], {
        packageRoot: fixture,
        baseURL: origin,
        fetch,
      });
      assert.equal(code, 1);
      assert.ok(result.failures.some((failure) => failure.includes("missing logoHash")));
      assert.ok(result.failures.some((failure) => failure.includes("hash mismatch")));
      assert.equal(
        result.failures.some((failure) => failure.includes(DAPP_PATH)),
        false,
      );
      const goodFile = path.join(dest, GOOD_PATH);
      assert.equal(fs.existsSync(goodFile), true);
      assert.deepEqual(fs.readFileSync(goodFile), GOOD);
      assert.deepEqual(fs.readFileSync(path.join(dest, DAPP_PATH)), GOOD);
      assert.equal(fs.existsSync(path.join(dest, MISSING_PATH)), false);
      assert.equal(fs.existsSync(path.join(dest, BAD_PATH)), false);
      assert.ok(urls.some((url) => url.includes(DAPP_PATH)));
      assert.equal(fs.existsSync(`${goodFile}.partial`), false);
      assert.ok(accepts.every((accept) => accept === "application/octet-stream"));
      assert.ok(accepts.every((accept) => !accept.includes("image/")));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("hashes the decoded body when the response is gzip", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-gz-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-gz-out-"));
    const gzipPath = "tokens/eip155-1/gzip.webp";
    fs.mkdirSync(path.join(fixture, "tokens"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "tokens", "eip155-1.json"),
      `${JSON.stringify([{ logoURL: gzipPath, logoHash: GOOD_HASH }])}\n`,
    );
    const { server, origin } = await startServer();
    try {
      const result = await logos.fetchLogos({
        destDir: dest,
        packageRoot: fixture,
        baseURL: origin,
        fetch,
      });
      assert.deepEqual(result.failures, []);
      assert.deepEqual(fs.readFileSync(path.join(dest, gzipPath)), GOOD);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("help describes an optional baseURL and does not mention raw GitHub", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "dist", "fetch-logos.js"), "utf8");
    assert.match(source, /baseURL is optional/);
    assert.match(source, /https:\/\/assets\.example\.com\//);
    assert.match(source, /https:\/\/cdn\.jsdelivr\.net\/gh\/bifrostwallet\/assets@1\.0\.0\/data\//);
    assert.equal(sourceContainsHostname(source, "raw.githubusercontent.com"), false);
    assert.equal(source.includes("logo-hashes.json"), false);
    assert.match(source, /providers\|tokens\|contracts\|dapps/);
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", "logo-hashes.json")), false);
    const published = publishedLogoURLs(path.join(process.cwd(), "dist"));
    assert.equal(
      published.some((logoURL) => logoURL.startsWith("dapps/")),
      false,
    );
    const provider = "providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp";
    const providers = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "dist", "providers", "eip155-14.json"), "utf8"),
    ) as Array<{ logoURL: string; logoHash: string }>;
    const listed = providers.find((entry) => entry.logoURL === provider);
    assert.ok(listed);
    assert.equal(
      listed.logoHash,
      createHash("sha256")
        .update(fs.readFileSync(path.join(process.cwd(), "data", provider)))
        .digest("hex"),
    );
  });
});
