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
const DAPP_BAD = "dapps/tampered-app/logo.webp";

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
        { logoURL: DAPP_BAD, logoHash: GOOD_HASH },
      ],
      null,
      2,
    )}\n`,
  );
}

function readCatalogEntry(
  relativePath: string,
  pick: (
    rows: Array<{ logoURL: string; logoHash: string }>,
  ) => { logoURL: string; logoHash: string } | undefined,
): { logoURL: string; logoHash: string } {
  const rows = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "dist", relativePath), "utf8"),
  ) as Array<{ logoURL: string; logoHash: string }>;
  const entry = pick(rows);
  assert.ok(entry?.logoURL);
  assert.match(entry.logoHash, /^[0-9a-f]{64}$/);
  return entry;
}

function startCatalogServer(): Promise<{ server: Server; origin: string }> {
  const dataRoot = path.resolve(process.cwd(), "data");
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.includes("missing.webp")) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    if (url.includes("tampered.webp")) {
      res.end(Buffer.from("not-the-logo"));
      return;
    }
    const relative = decodeURIComponent(url.replace(/^\/data\//, "").split("?")[0] ?? "");
    const file = path.resolve(dataRoot, relative);
    if (!file.startsWith(`${dataRoot}${path.sep}`) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, origin: `http://127.0.0.1:${address.port}/data/` });
    });
  });
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
    if (url.endsWith(BAD_PATH) || url.endsWith(DAPP_BAD)) {
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

  test("fetchLogo returns verified bytes for each catalog entry and rejects failures", async () => {
    const indexPath = path.join(process.cwd(), "dist", "index.js");
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const { fetchLogo } = require(indexPath) as {
      fetchLogo: (
        entry: { logoURL: string; logoHash: string },
        options?: { fetch?: typeof fetch },
      ) => Promise<Uint8Array>;
    };
    const provider = readCatalogEntry("providers/eip155-14.json", (rows) =>
      rows.find((row) => row.logoURL.includes("0x1650d2760baee638c034200dedcbe17b050d0364")),
    );
    const token = readCatalogEntry("tokens/eip155-14.json", (rows) =>
      rows.find((row) =>
        row.logoURL.endsWith("/0x1d80c49bbbcd1c0911346656b529df9e5c2f783d/logo.webp"),
      ),
    );
    const contract = readCatalogEntry("contracts/eip155-14.json", (rows) => rows[0]);
    const { server, origin } = await startCatalogServer();
    try {
      for (const entry of [provider, token, contract]) {
        const bytes = await fetchLogo(
          { ...entry, logoURL: `${origin}${entry.logoURL}` },
          { fetch },
        );
        assert.deepEqual(
          Buffer.from(bytes),
          fs.readFileSync(path.join(process.cwd(), "data", entry.logoURL)),
        );
      }
      await assert.rejects(
        () =>
          fetchLogo(
            { logoURL: `${origin}providers/eip155-14/tampered.webp`, logoHash: GOOD_HASH },
            { fetch },
          ),
        /logo hash mismatch/,
      );
      await assert.rejects(
        () =>
          fetchLogo(
            { logoURL: `${origin}providers/eip155-14/missing.webp`, logoHash: GOOD_HASH },
            { fetch },
          ),
        /Could not fetch logo: HTTP 404/,
      );
      await assert.rejects(
        () =>
          fetchLogo(
            { logoURL: "https://logos.example/logo.webp", logoHash: GOOD_HASH },
            {
              fetch: async () => {
                throw new Error("socket hang up");
              },
            },
          ),
        /Could not fetch logo: socket hang up/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
      assert.ok(
        result.failures.some((failure) => failure.includes(`${DAPP_BAD}: logo hash mismatch`)),
      );
      assert.equal(fs.existsSync(path.join(dest, DAPP_BAD)), false);
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

  test("runCli with a leading fetch-logos argument matches a destination-only call", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-bin-"));
    const plainDest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-bin-plain-"));
    const binDest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-bin-argv-"));
    writeFixture(fixture);
    const { server, origin } = await startServer();
    try {
      const plain = await logos.runCli([plainDest], {
        packageRoot: fixture,
        baseURL: origin,
        fetch,
      });
      const withBin = await logos.runCli(["fetch-logos", binDest], {
        packageRoot: fixture,
        baseURL: origin,
        fetch,
      });
      assert.equal(withBin, plain);
      for (const relative of [GOOD_PATH, DAPP_PATH, MISSING_PATH, BAD_PATH, DAPP_BAD]) {
        const plainFile = path.join(plainDest, relative);
        const binFile = path.join(binDest, relative);
        assert.equal(fs.existsSync(binFile), fs.existsSync(plainFile));
        if (!fs.existsSync(plainFile)) continue;
        assert.deepEqual(fs.readFileSync(binFile), fs.readFileSync(plainFile));
      }
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
    const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
      .version as string;
    assert.ok(source.includes(`https://cdn.jsdelivr.net/gh/bifrostwallet/assets@${version}/data/`));
    assert.equal(sourceContainsHostname(source, "raw.githubusercontent.com"), false);
    assert.equal(source.includes("logo-hashes.json"), false);
    assert.match(source, /providers\|tokens\|contracts\|dapps/);
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", "logo-hashes.json")), false);
    const published = publishedLogoURLs(path.join(process.cwd(), "dist"));
    const dapps = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "dist", "dapps", "dapps.json"), "utf8"),
    ) as Array<{ logoURL: string; logoHash: string }>;
    assert.ok(dapps.length > 0);
    for (const dapp of dapps) {
      assert.match(dapp.logoURL, /^dapps\//);
      assert.match(dapp.logoHash, /^[0-9a-f]{64}$/);
      assert.ok(published.includes(dapp.logoURL));
    }
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
