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

interface LogoResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface ProgressEvent {
  type: string;
  total?: number;
  source?: string;
  fetched?: number;
  retrying?: number;
  failed?: number;
  retried?: number;
  elapsed?: string;
  logoPath?: string;
  attempt?: number;
  retries?: number;
  status?: number | string;
}

interface FetchLogoOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<LogoResponse>;
  retries?: number;
  retryDelay?: number;
  progressEvery?: number;
  progressIntervalMs?: number;
  onProgress?: (event: ProgressEvent) => void;
}

interface FetchLogosModule {
  fetchLogo: (
    entry: { logoURL: string; logoHash: string },
    options?: FetchLogoOptions,
  ) => Promise<Uint8Array>;
  fetchLogos: (
    options: FetchLogoOptions & {
      destDir: string;
      packageRoot?: string;
      baseURL?: string;
    },
  ) => Promise<{ written: string[]; failures: string[] }>;
  runCli: (
    argv: string[],
    deps?: FetchLogoOptions & { packageRoot?: string; baseURL?: string },
  ) => Promise<number>;
  verifyLogoHash: (bytes: Uint8Array, expectedHash: string) => boolean;
}

function responseWith(status: number, body?: Buffer): LogoResponse {
  const payload = body ? Buffer.from(body) : Buffer.alloc(0);
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      return copy.buffer;
    },
  };
}

function writeCatalog(root: string, entries: Array<{ logoURL: string; logoHash: string }>): void {
  fs.mkdirSync(path.join(root, "tokens"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tokens", "eip155-1.json"),
    `${JSON.stringify(entries, null, 2)}\n`,
  );
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
    assert.match(source, /Downloads two logos at a time/);
    assert.match(source, /HTTP 403, 408, 429, and 5xx/);
    assert.match(source, /Progress is printed to stderr/);
    assert.match(source, /CDN_CONCURRENCY = 2/);
    assert.match(source, /DEFAULT_RETRIES = 5/);
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

  test("retries HTTP 403 and returns the verified bytes", async () => {
    let calls = 0;
    const bytes = await logos.fetchLogo(
      { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
      {
        retries: 5,
        retryDelay: 1,
        fetch: async () => {
          calls += 1;
          if (calls === 1) return responseWith(403);
          return responseWith(200, GOOD);
        },
      },
    );
    assert.equal(calls, 2);
    assert.deepEqual(Buffer.from(bytes), GOOD);
  });

  test("a persistent HTTP 403 fails after the retries run out", async () => {
    let calls = 0;
    const times: number[] = [];
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
          {
            retries: 2,
            retryDelay: 20,
            fetch: async () => {
              times.push(Date.now());
              calls += 1;
              return responseWith(403);
            },
          },
        ),
      /Could not fetch logo: HTTP 403/,
    );
    assert.equal(calls, 3);
    assert.ok(times[1] - times[0] >= 15);
    assert.ok(times[2] - times[1] >= 35);
  });

  test("does not retry HTTP 404", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/missing.webp", logoHash: GOOD_HASH },
          {
            retries: 5,
            retryDelay: 1,
            fetch: async () => {
              calls += 1;
              return responseWith(404);
            },
          },
        ),
      /Could not fetch logo: HTTP 404/,
    );
    assert.equal(calls, 1);
  });

  test("does not retry a hash mismatch or an oversize response", async () => {
    let mismatchCalls = 0;
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
          {
            retries: 5,
            retryDelay: 1,
            fetch: async () => {
              mismatchCalls += 1;
              return responseWith(200, Buffer.from("not-the-logo"));
            },
          },
        ),
      /logo hash mismatch/,
    );
    assert.equal(mismatchCalls, 1);

    let oversizeCalls = 0;
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
          {
            retries: 4,
            retryDelay: 1,
            fetch: async () => {
              oversizeCalls += 1;
              return responseWith(200, Buffer.alloc(256 * 1024 + 1));
            },
          },
        ),
      /response exceeds 256KB/,
    );
    assert.equal(oversizeCalls, 1);
  });

  test("fetchLogo stays single-shot unless retries is set", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
          {
            fetch: async () => {
              calls += 1;
              return responseWith(403);
            },
          },
        ),
      /Could not fetch logo: HTTP 403/,
    );
    assert.equal(calls, 1);
  });

  test("retries a network error and HTTP 408, 429, and 500", async () => {
    for (const status of [408, 429, 500, 503]) {
      let calls = 0;
      const bytes = await logos.fetchLogo(
        { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
        {
          retries: 1,
          retryDelay: 1,
          fetch: async () => {
            calls += 1;
            if (calls === 1) return responseWith(status);
            return responseWith(200, GOOD);
          },
        },
      );
      assert.equal(calls, 2, `status ${status}`);
      assert.deepEqual(Buffer.from(bytes), GOOD);
    }

    let calls = 0;
    const bytes = await logos.fetchLogo(
      { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
      {
        retries: 1,
        retryDelay: 1,
        fetch: async () => {
          calls += 1;
          if (calls === 1) throw new Error("socket hang up");
          return responseWith(200, GOOD);
        },
      },
    );
    assert.equal(calls, 2);
    assert.deepEqual(Buffer.from(bytes), GOOD);

    let rejected = 0;
    await assert.rejects(
      () =>
        logos.fetchLogo(
          { logoURL: "https://cdn.example/logo.webp", logoHash: GOOD_HASH },
          {
            retries: 4,
            retryDelay: 1,
            fetch: async () => {
              rejected += 1;
              return responseWith(400);
            },
          },
        ),
      /Could not fetch logo: HTTP 400/,
    );
    assert.equal(rejected, 1);
  });

  test("downloads at most two logos at a time", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-pool-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-pool-out-"));
    const entries = Array.from({ length: 6 }, (_, index) => ({
      logoURL: `tokens/eip155-1/${index}.webp`,
      logoHash: GOOD_HASH,
    }));
    writeCatalog(fixture, entries);
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await logos.fetchLogos({
      destDir: dest,
      packageRoot: fixture,
      baseURL: "https://cdn.example/data/",
      retryDelay: 1,
      progressIntervalMs: 0,
      onProgress: () => {},
      fetch: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return responseWith(200, GOOD);
      },
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.written.length, 6);
    assert.equal(maxInFlight, 2);
  });

  test("reports progress for every 50 logos and on a timer", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-progress-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-progress-out-"));
    writeCatalog(
      fixture,
      Array.from({ length: 50 }, (_, index) => ({
        logoURL: `tokens/eip155-1/${index}.webp`,
        logoHash: GOOD_HASH,
      })),
    );
    const events: ProgressEvent[] = [];
    const result = await logos.fetchLogos({
      destDir: dest,
      packageRoot: fixture,
      baseURL: "https://cdn.example/data/",
      progressIntervalMs: 0,
      onProgress: (event) => events.push(event),
      fetch: async () => responseWith(200, GOOD),
    });
    assert.deepEqual(result.failures, []);
    assert.equal(events[0]?.type, "start");
    assert.equal(events[0]?.total, 50);
    assert.equal(events[0]?.source, "https://cdn.example/data/");
    assert.ok(
      events.some(
        (event) =>
          event.type === "progress" &&
          event.fetched === 50 &&
          event.total === 50 &&
          event.retrying === 0 &&
          event.failed === 0,
      ),
    );
    const summary = events.at(-1);
    assert.equal(summary?.type, "summary");
    assert.equal(summary?.fetched, 50);
    assert.equal(summary?.retried, 0);
    assert.equal(summary?.failed, 0);
    assert.match(summary?.elapsed ?? "", /^\d+\.\ds$/);

    const slowFixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-tick-"));
    const slowDest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-tick-out-"));
    writeCatalog(slowFixture, [{ logoURL: GOOD_PATH, logoHash: GOOD_HASH }]);
    const ticks: ProgressEvent[] = [];
    await logos.fetchLogos({
      destDir: slowDest,
      packageRoot: slowFixture,
      baseURL: "https://cdn.example/data/",
      progressEvery: 50,
      progressIntervalMs: 30,
      onProgress: (event) => ticks.push(event),
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 160));
        return responseWith(200, GOOD);
      },
    });
    assert.ok(ticks.some((event) => event.type === "progress" && event.fetched === 0));
    assert.equal(ticks.at(-1)?.type, "summary");
  });

  test("prints progress and retry notes to stderr", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-stderr-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-stderr-out-"));
    writeCatalog(fixture, [{ logoURL: GOOD_PATH, logoHash: GOOD_HASH }]);
    const lines: string[] = [];
    const original = console.error;
    console.error = ((line?: unknown) => {
      lines.push(String(line));
    }) as typeof console.error;
    try {
      let calls = 0;
      const code = await logos.runCli([dest], {
        packageRoot: fixture,
        baseURL: "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.3.0/data",
        retryDelay: 1,
        progressEvery: 1,
        progressIntervalMs: 0,
        fetch: async () => {
          calls += 1;
          if (calls === 1) return responseWith(403);
          return responseWith(200, GOOD);
        },
      });
      assert.equal(code, 0);
      assert.equal(calls, 2);
    } finally {
      console.error = original;
    }
    assert.equal(
      lines[0],
      "fetching 1 logo from https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.3.0/data/",
    );
    assert.ok(lines.includes(`retry ${GOOD_PATH} attempt 1/5, HTTP 403`));
    assert.ok(lines.includes("fetched 1/1, 0 retrying, 0 failed"));
    assert.match(lines.at(-1) ?? "", /^fetched 1, retried 1, failed 0, elapsed \d+\.\ds$/);
    assert.equal(
      lines.some((line) => line.includes("\r")),
      false,
    );
    assert.deepEqual(fs.readFileSync(path.join(dest, GOOD_PATH)), GOOD);
  });

  test("counts logos that are waiting to retry", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-retrying-"));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "assets-logos-retrying-out-"));
    const paths = ["tokens/eip155-1/a.webp", "tokens/eip155-1/b.webp"];
    writeCatalog(
      fixture,
      paths.map((logoURL) => ({ logoURL, logoHash: GOOD_HASH })),
    );
    const seen = new Map<string, number>();
    let releaseSecond: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let maxRetrying = 0;
    const pending = logos.fetchLogos({
      destDir: dest,
      packageRoot: fixture,
      baseURL: "https://cdn.example/data/",
      retryDelay: 5,
      progressIntervalMs: 0,
      onProgress: (event) => {
        if (event.type === "retry") maxRetrying = Math.max(maxRetrying, event.retrying ?? 0);
      },
      fetch: async (url: string) => {
        const count = (seen.get(url) ?? 0) + 1;
        seen.set(url, count);
        if (count === 1) return responseWith(403);
        await hold;
        return responseWith(200, GOOD);
      },
    });
    try {
      const deadline = Date.now() + 1000;
      while (maxRetrying < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(maxRetrying, 2);
    } finally {
      releaseSecond();
    }
    const result = await pending;
    assert.deepEqual(result.failures, []);
    assert.equal(result.written.length, 2);
  });
});
