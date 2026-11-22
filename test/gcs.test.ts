import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { crc32cBase64 } from "../src/crc32c.js";
import {
  type AccessTokenSource,
  createGcsClient,
  defaultTokenSource,
  GCS_MAX_RETRIES,
  GcsHttpError,
  GcsIntegrityError,
  GcsObjectTooLargeError,
  GcsResponseError,
} from "../src/gcs.js";

interface Call {
  url: string;
  method: string;
  redirect: string | undefined;
  headers: Headers;
}

type Reply = () => Response;

const crc = (data: Buffer): string => crc32cBase64(data);

function status(code: number): Reply {
  return () => new Response("error", { status: code });
}

function networkError(): Reply {
  return () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
  };
}

/** Hands out tok-1, tok-2, … and records whether each one was a refresh. */
function tokens(refreshable = true): AccessTokenSource & { asks: boolean[] } {
  const asks: boolean[] = [];
  let issued = 0;
  return {
    asks,
    refreshable,
    async token(refresh) {
      asks.push(refresh);
      if (refresh || issued === 0) issued++;
      return `tok-${issued}`;
    },
  };
}

/** Replies are consumed in order. */
function harness(replies: Reply[], tokenSource = tokens()) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      headers: new Headers(init?.headers),
    });
    const reply = replies[calls.length - 1];
    if (!reply) {
      throw new Error(`unexpected fetch call #${calls.length}`);
    }
    return reply();
  }) as typeof fetch;
  const client = createGcsClient({
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    tokenSource,
  });
  return { client, calls, sleeps, tokenSource };
}

describe("gcs client", () => {
  test("lists every page with name, size and generation", async () => {
    const h = harness([
      () =>
        Response.json({
          items: [{ name: "eip155-14/0xabc.json", size: "120", generation: "1700000000000001" }],
          nextPageToken: "page-2",
        }),
      () => Response.json({ items: [{ name: "eip155-14/x.json", size: "7", generation: "5" }] }),
    ]);

    const objects = await h.client.list("intake bucket");

    assert.deepEqual(objects, [
      { name: "eip155-14/0xabc.json", size: 120, generation: "1700000000000001" },
      { name: "eip155-14/x.json", size: 7, generation: "5" },
    ]);
    const first = new URL(h.calls[0]?.url ?? "");
    assert.equal(
      first.origin + first.pathname,
      "https://storage.googleapis.com/storage/v1/b/intake%20bucket/o",
    );
    assert.equal(first.searchParams.get("fields"), "items(name,size,generation),nextPageToken");
    assert.equal(first.searchParams.has("pageToken"), false);
    assert.equal(new URL(h.calls[1]?.url ?? "").searchParams.get("pageToken"), "page-2");
    assert.equal(h.calls[0]?.headers.get("authorization"), "Bearer tok-1");
  });

  test("lists an empty bucket", async () => {
    const h = harness([() => Response.json({})]);
    assert.deepEqual(await h.client.list("b"), []);
  });

  test("rejects a list item without name, size and generation", async () => {
    const h = harness([() => Response.json({ items: [{ name: "a.json" }] })]);
    await assert.rejects(h.client.list("b"), GcsResponseError);
    assert.equal(h.calls.length, 1);
  });

  test("downloads one generation of an object", async () => {
    const h = harness([() => new Response(Buffer.from([1, 2, 3]))]);

    const data = await h.client.download("my-bucket", "eip155-14/abc def.json", {
      generation: "42",
    });

    assert.deepEqual(data, Buffer.from([1, 2, 3]));
    assert.equal(
      h.calls[0]?.url,
      "https://storage.googleapis.com/storage/v1/b/my-bucket/o/eip155-14%2Fabc%20def.json?alt=media&generation=42",
    );
  });

  test("returns undefined for a missing object without retrying", async () => {
    const h = harness([status(404)]);

    assert.equal(await h.client.download("b", "k"), undefined);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  });

  test("rejects an object over maxBytes by its declared length or its body", async () => {
    const declared = harness([
      () => new Response("x".repeat(10), { headers: { "content-length": "10" } }),
    ]);
    await assert.rejects(
      declared.client.download("b", "k", { maxBytes: 9 }),
      GcsObjectTooLargeError,
    );
    assert.equal(declared.calls.length, 1);

    const undeclared = harness([
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(10));
              controller.close();
            },
          }),
        ),
    ]);
    await assert.rejects(
      undeclared.client.download("b", "k", { maxBytes: 9 }),
      GcsObjectTooLargeError,
    );
  });

  test("accepts a download whose bytes match the object CRC32C", async () => {
    const data = Buffer.from('{"kind":"provider"}');
    const h = harness([
      () =>
        new Response(data, {
          headers: {
            "x-goog-hash": `crc32c=${crc(data)}, md5=AAAAAAAAAAAAAAAAAAAAAA==`,
            "x-goog-stored-content-encoding": "identity",
          },
        }),
    ]);

    assert.deepEqual(await h.client.download("b", "k"), data);
  });

  test("rejects a download whose bytes do not match the object CRC32C, without retrying", async () => {
    const h = harness([
      () =>
        new Response(Buffer.from("tampered"), {
          headers: {
            "x-goog-hash": `crc32c=${crc(Buffer.from("original"))},md5=AAAAAAAAAAAAAAAAAAAAAA==`,
          },
        }),
    ]);

    await assert.rejects(h.client.download("b", "k"), GcsIntegrityError);
    assert.equal(h.calls.length, 1);
  });

  test("skips the CRC32C check for an object stored compressed", async () => {
    const data = Buffer.from('{"decoded":true}');
    const h = harness([
      () =>
        new Response(data, {
          headers: {
            "x-goog-hash": `crc32c=${crc(Buffer.from("gzip-bytes"))}`,
            "x-goog-stored-content-encoding": "gzip",
          },
        }),
    ]);

    assert.deepEqual(await h.client.download("b", "k"), data);
  });

  test("never follows a redirect", async () => {
    const redirect: Reply = () =>
      new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
    const h = harness([redirect]);

    await assert.rejects(
      h.client.download("b", "k"),
      (error) => error instanceof GcsHttpError && error.status === 302,
    );
    assert.deepEqual(
      h.calls.map((call) => call.redirect),
      ["manual"],
    );
  });

  test("retries 503, 429 and network failures with backoff, then succeeds", async () => {
    for (const failure of [status(503), status(429), networkError()]) {
      const h = harness([failure, failure, () => new Response("ok")]);

      assert.deepEqual(await h.client.download("b", "k"), Buffer.from("ok"));
      assert.deepEqual(h.sleeps, [1_000, 2_000]);
    }
  });

  test("retries a download whose body breaks off after a 200", async () => {
    const brokenBody: Reply = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            controller.error(new TypeError("terminated"));
          },
        }),
      );
    const h = harness([brokenBody, () => new Response(Buffer.from([1, 2, 3]))]);

    assert.deepEqual(await h.client.download("b", "k"), Buffer.from([1, 2, 3]));
    assert.equal(h.calls.length, 2);
  });

  test("throws the last error once the retry budget is spent", async () => {
    const h = harness(Array.from({ length: 1 + GCS_MAX_RETRIES }, () => status(503)));

    await assert.rejects(
      h.client.list("b"),
      (error) => error instanceof GcsHttpError && error.status === 503,
    );
    assert.equal(h.calls.length, 1 + GCS_MAX_RETRIES);
  });

  test("does not retry 403", async () => {
    const h = harness([status(403)]);

    await assert.rejects(
      h.client.download("b", "k"),
      (error) => error instanceof GcsHttpError && error.status === 403,
    );
    assert.equal(h.calls.length, 1);
  });

  test("asks for a new token after a 401 when the source can refresh", async () => {
    const h = harness([status(401), () => new Response("ok")]);

    assert.deepEqual(await h.client.download("b", "k"), Buffer.from("ok"));
    assert.equal(h.calls[0]?.headers.get("authorization"), "Bearer tok-1");
    assert.equal(h.calls[1]?.headers.get("authorization"), "Bearer tok-2");
    assert.deepEqual(h.tokenSource.asks, [false, true]);
  });

  test("fails on a 401 when the token cannot be replaced", async () => {
    const h = harness([status(401)], tokens(false));

    await assert.rejects(
      h.client.download("b", "k"),
      (error) => error instanceof GcsHttpError && error.status === 401,
    );
    assert.equal(h.calls.length, 1);
  });
});

describe("default token source", () => {
  test("uses GCS_ACCESS_TOKEN as given and does not refresh it", async () => {
    const source = defaultTokenSource({ GCS_ACCESS_TOKEN: " ya29.from-ci \n" });

    assert.equal(source.refreshable, false);
    assert.equal(await source.token(false), "ya29.from-ci");
    assert.equal(await source.token(true), "ya29.from-ci");
  });

  test("falls back to gcloud when GCS_ACCESS_TOKEN is unset or blank", () => {
    assert.equal(defaultTokenSource({}).refreshable, true);
    assert.equal(defaultTokenSource({ GCS_ACCESS_TOKEN: "  " }).refreshable, true);
  });
});
