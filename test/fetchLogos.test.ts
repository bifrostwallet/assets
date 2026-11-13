import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

const GOOD = Buffer.from("webp-bytes-for-the-hash-check");
const GOOD_HASH = createHash("sha256").update(GOOD).digest("hex");

interface LogoResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

interface FetchLogoOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<LogoResponse>;
  retries?: number;
  retryDelay?: number;
}

interface LogoModule {
  fetchLogo: (
    entry: { logoURL: string; logoHash: string },
    options?: FetchLogoOptions,
  ) => Promise<Uint8Array>;
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

describe("verifyLogoHash and fetchLogo", { concurrency: false }, () => {
  let releaseDist: (() => void) | undefined;
  let logos: LogoModule;
  let verifyFromPackage: LogoModule["verifyLogoHash"];

  before(() => {
    releaseDist = holdPackageDist();
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const hashPath = path.join(process.cwd(), "dist", "verify-logo-hash.js");
    logos = require(hashPath) as LogoModule;
    const indexPath = path.join(process.cwd(), "dist", "index.js");
    delete require.cache[indexPath];
    verifyFromPackage = (require(indexPath) as LogoModule).verifyLogoHash;
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", "fetch-logos.js")), false);
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
});
