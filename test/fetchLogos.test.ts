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

const GOOD = Buffer.from("webp-bytes-for-the-hash-check");
const GOOD_HASH = createHash("sha256").update(GOOD).digest("hex");
const GOOD_PATH = "tokens/eip155-1/0xabc/logo.webp";
const MISSING_PATH = "tokens/eip155-1/0xdef/logo.webp";
const BAD_PATH = "providers/eip155-14/0x123/logo.webp";

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
    path.join(root, "logo-hashes.json"),
    `${JSON.stringify(
      {
        [BAD_PATH]: GOOD_HASH,
        [GOOD_PATH]: GOOD_HASH,
        [MISSING_PATH]: GOOD_HASH,
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(root, "tokens", "eip155-1.json"),
    `${JSON.stringify(
      [
        { logoURL: GOOD_PATH, logoHash: GOOD_HASH },
        { logoURL: MISSING_PATH },
        { logoURL: BAD_PATH, logoHash: GOOD_HASH },
      ],
      null,
      2,
    )}\n`,
  );
}

function startServer(): Promise<{ server: Server; origin: string; accepts: string[] }> {
  const accepts: string[] = [];
  const server = createServer((req, res) => {
    accepts.push(String(req.headers.accept ?? ""));
    const url = req.url ?? "";
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
      resolve({ server, origin: `http://127.0.0.1:${address.port}/data/`, accepts });
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
    const { server, origin, accepts } = await startServer();
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
      const goodFile = path.join(dest, GOOD_PATH);
      assert.equal(fs.existsSync(goodFile), true);
      assert.deepEqual(fs.readFileSync(goodFile), GOOD);
      assert.equal(fs.existsSync(path.join(dest, MISSING_PATH)), false);
      assert.equal(fs.existsSync(path.join(dest, BAD_PATH)), false);
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
    fs.writeFileSync(
      path.join(fixture, "logo-hashes.json"),
      `${JSON.stringify({ [gzipPath]: GOOD_HASH })}\n`,
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
    assert.equal(source.includes("raw.githubusercontent"), false);
    const hashes = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "dist", "logo-hashes.json"), "utf8"),
    ) as Record<string, string>;
    const provider = "providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp";
    assert.equal(
      hashes[provider],
      createHash("sha256")
        .update(fs.readFileSync(path.join(process.cwd(), "data", provider)))
        .digest("hex"),
    );
    const dapp = "dapps/sparkdex-ai/logo.webp";
    assert.equal(
      hashes[dapp],
      createHash("sha256")
        .update(fs.readFileSync(path.join(process.cwd(), "data", dapp)))
        .digest("hex"),
    );
  });
});
