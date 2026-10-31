import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { describe, test } from "node:test";
import {
  DOMAIN_LINKAGE_RECORD_RE,
  dnsLinkageName,
  expectedDomainLinkageRecord,
  extractAllowlistedRecords,
  extractAllowlistedRecordsFromTxt,
  isAllowedPublicHostname,
  isBlockedIpAddress,
  isInconclusiveDomainLinkage,
  verifyProviderDomainLinkage,
} from "../src/domainLinkage.js";

describe("domainLinkage", () => {
  test("expectedDomainLinkageRecord formats CAIP-2 + identity", () => {
    assert.equal(
      expectedDomainLinkageRecord("eip155-14", "0xAbCDEF0000000000000000000000000000000001"),
      "eip155:14:0xabcdef0000000000000000000000000000000001",
    );
  });

  test("allowlisted record regex rejects garbage", () => {
    assert.equal(
      DOMAIN_LINKAGE_RECORD_RE.test("eip155:14:0xabcdef0000000000000000000000000000000001"),
      true,
    );
    assert.equal(
      DOMAIN_LINKAGE_RECORD_RE.test("eip155:14:0xAbCdEf0000000000000000000000000000000001"),
      true,
    );
    assert.equal(
      DOMAIN_LINKAGE_RECORD_RE.test("eip155:1:0xabcdef0000000000000000000000000000000001"),
      false,
    );
    assert.equal(DOMAIN_LINKAGE_RECORD_RE.test("http://evil"), false);
    assert.equal(DOMAIN_LINKAGE_RECORD_RE.test("eip155:14:0xabc"), false);
  });

  test("extractAllowlistedRecords accepts comma / semicolon / whitespace lists", () => {
    const text = [
      "# comment",
      "eip155:14:0xAbCdEf0000000000000000000000000000000001, eip155:19:0xabcdef0000000000000000000000000000000002;",
      "ignore-this-token",
      "<script>alert(1)</script>",
    ].join("\n");
    const records = extractAllowlistedRecords(text);
    assert.deepEqual(
      [...records].sort(),
      [
        "eip155:14:0xabcdef0000000000000000000000000000000001",
        "eip155:19:0xabcdef0000000000000000000000000000000002",
      ].sort(),
    );
  });

  test("extractAllowlistedRecords accepts one-per-line (whitespace separators)", () => {
    const text = [
      "eip155:14:0x1650d2760baee638c034200dedcbe17b050d0364",
      "eip155:19:0x7429E0C70306834E2B210cf3FEB306342f456ce7",
    ].join("\n");
    const records = extractAllowlistedRecords(text);
    assert.equal(records.has("eip155:14:0x1650d2760baee638c034200dedcbe17b050d0364"), true);
    assert.equal(records.has("eip155:19:0x7429e0c70306834e2b210cf3feb306342f456ce7"), true);
  });

  test("extractAllowlistedRecordsFromTxt joins TXT chunks and multiple RRs", () => {
    const records = extractAllowlistedRecordsFromTxt([
      ["eip155:14:0xabcdef0000000000000000000000000000000001"],
      ["garbage"],
      ["eip155:19:", "0xAbCdEf0000000000000000000000000000000002"],
      [
        "eip155:14:0x1111111111111111111111111111111111111111,eip155:19:0x2222222222222222222222222222222222222222",
      ],
    ]);
    assert.equal(records.has("eip155:14:0xabcdef0000000000000000000000000000000001"), true);
    assert.equal(records.has("eip155:19:0xabcdef0000000000000000000000000000000002"), true);
    assert.equal(records.has("eip155:14:0x1111111111111111111111111111111111111111"), true);
    assert.equal(records.has("eip155:19:0x2222222222222222222222222222222222222222"), true);
    assert.equal(records.size, 4);
  });

  test("dnsLinkageName uses _providers label", () => {
    assert.equal(dnsLinkageName("example.com"), "_providers.example.com");
  });

  test("verifyProviderDomainLinkage matches file and dns via mocks", async () => {
    const identity = "0xabcdef0000000000000000000000000000000001";
    const record = `eip155:14:${identity}`;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/providers.txt")) {
        return new Response(
          `${record},eip155:19:0xabcdef0000000000000000000000000000000002\n# noise\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          },
        );
      }
      return new Response("missing", { status: 404 });
    };

    const resolveTxt = async (name: string) => {
      if (name === "_providers.example.com") return [[record]];
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    };

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: identity,
      websiteURL: "https://example.com",
      fetchImpl,
      resolveTxt,
    });

    assert.equal(result.file.matched, true);
    assert.equal(result.dns.matched, true);
    assert.equal(result.linked, true);
  });

  test("verifyProviderDomainLinkage ignores disallowed content types and redirects", async () => {
    const identity = "0xabcdef0000000000000000000000000000000001";

    const htmlFetch: typeof fetch = async () =>
      new Response(`<html>${identity}</html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });

    const htmlResult = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: identity,
      websiteURL: "https://example.com",
      fetchImpl: htmlFetch,
      resolveTxt: async () => {
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      },
    });
    assert.equal(htmlResult.file.matched, false);
    assert.match(htmlResult.file.error ?? "", /Content-Type/);

    const redirectFetch: typeof fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example/steal" },
      });

    const redirectResult = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: identity,
      websiteURL: "https://example.com",
      fetchImpl: redirectFetch,
      resolveTxt: async () => [],
    });
    assert.equal(redirectResult.file.matched, false);
    assert.match(redirectResult.file.error ?? "", /Redirect/);
  });

  test("verifyProviderDomainLinkage blocks private hosts", async () => {
    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: "0xabcdef0000000000000000000000000000000001",
      websiteURL: "https://127.0.0.1",
    });
    assert.equal(result.linked, false);
    assert.match(result.file.error ?? "", /not allowed/);
  });

  test("isBlockedIpAddress rejects metadata and VPC ranges", () => {
    assert.equal(isBlockedIpAddress("169.254.169.254"), true);
    assert.equal(isBlockedIpAddress("10.128.0.2"), true);
    assert.equal(isBlockedIpAddress("192.168.0.1"), true);
    assert.equal(isBlockedIpAddress("::ffff:169.254.169.254"), true);
    assert.equal(isBlockedIpAddress("1.1.1.1"), false);
  });

  test("isAllowedPublicHostname rejects metadata and platform hostnames", () => {
    assert.equal(isAllowedPublicHostname("metadata.google.internal"), false);
    assert.equal(isAllowedPublicHostname("my-app.vercel.app"), false);
    assert.equal(isAllowedPublicHostname("svc-abc-uc.a.run.app"), false);
    assert.equal(isAllowedPublicHostname("bucket.s3.amazonaws.com"), false);
    assert.equal(isAllowedPublicHostname("example.com"), true);
    assert.equal(isAllowedPublicHostname("www.example.com"), true);
  });

  test("verifyProviderDomainLinkage accepts single-side match when other side absent", async () => {
    const identity = "0xabcdef0000000000000000000000000000000001";
    const record = `eip155:14:${identity}`;

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: identity,
      websiteURL: "https://example.com",
      fetchImpl: async () =>
        new Response(`${record}\n`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      resolveTxt: async () => {
        throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
      },
    });
    assert.equal(result.file.matched, true);
    assert.equal(result.dns.matched, false);
    assert.equal(result.linked, true);
  });

  test("verifyProviderDomainLinkage rejects contradiction when both present", async () => {
    const identity = "0xabcdef0000000000000000000000000000000001";
    const other = "eip155:14:0x1111111111111111111111111111111111111111";
    const record = `eip155:14:${identity}`;

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: identity,
      websiteURL: "https://example.com",
      fetchImpl: async () =>
        new Response(`${record}\n`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      resolveTxt: async () => [[other]],
    });
    assert.equal(result.file.matched, true);
    assert.equal(result.dns.matched, false);
    assert.equal(result.linked, false);
    assert.match(`${result.file.error ?? ""}${result.dns.error ?? ""}`, /contradict/i);
  });

  const pinnedV4 = "1.1.1.1";
  const pinnedV6 = "2606:4700:4700::1111";
  const pinnedIdentity = "0xabcdef0000000000000000000000000000000001";
  const pinnedRecord = `eip155:14:${pinnedIdentity}`;

  function pinnedDial(options: {
    onDial: (
      ip: string,
      events: {
        timeout: () => void;
        fail: () => void;
        respond: (status: number, body: string) => void;
      },
    ) => void;
    emitErrorOnDestroy?: boolean;
  }): {
    dialed: string[];
    request: (
      requestOptions: RequestOptions,
      callback: (res: IncomingMessage) => void,
    ) => {
      on(event: "timeout" | "error", listener: () => void): void;
      destroy(): void;
      end(): void;
    };
  } {
    const dialed: string[] = [];
    const request = (requestOptions: RequestOptions, callback: (res: IncomingMessage) => void) => {
      const ip = String(requestOptions.host);
      dialed.push(ip);
      const handlers = new Map<string, () => void>();
      return {
        on(event: "timeout" | "error", listener: () => void) {
          handlers.set(event, listener);
        },
        destroy() {
          if (!options.emitErrorOnDestroy) return;
          queueMicrotask(() => {
            handlers.get("error")?.();
          });
        },
        end() {
          options.onDial(ip, {
            timeout: () => {
              handlers.get("timeout")?.();
            },
            fail: () => {
              handlers.get("error")?.();
            },
            respond: (status, body) => {
              const res = new EventEmitter() as IncomingMessage;
              res.statusCode = status;
              res.headers = { "content-type": "text/plain" };
              res.destroy = () => {
                res.emit("close");
                return res;
              };
              callback(res);
              queueMicrotask(() => {
                res.emit("data", Buffer.from(body));
                res.emit("end");
              });
            },
          });
        },
      };
    };
    return { dialed, request };
  }

  function dnsTimeout(): Promise<string[][]> {
    return Promise.reject(Object.assign(new Error("Timeout"), { code: "ETIMEOUT" }));
  }

  function dnsEmpty(): Promise<string[][]> {
    return Promise.reject(Object.assign(new Error("ENODATA"), { code: "ENODATA" }));
  }

  test("pinned fetch tries the next address after a timeout", async () => {
    const dial = pinnedDial({
      onDial: (ip, events) => {
        if (ip === pinnedV4) events.timeout();
        else events.respond(200, `${pinnedRecord}\n`);
      },
    });

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV6, pinnedV4],
      request: dial.request,
      resolveTxt: async () => [[pinnedRecord]],
    });

    assert.deepEqual(dial.dialed, [pinnedV4, pinnedV6]);
    assert.equal(result.file.matched, true);
    assert.equal(result.linked, true);
    assert.equal(isInconclusiveDomainLinkage(result), false);
  });

  test("pinned fetch still matches when destroy emits an error after timeout", async () => {
    const dial = pinnedDial({
      emitErrorOnDestroy: true,
      onDial: (ip, events) => {
        if (ip === pinnedV4) events.timeout();
        else events.respond(200, `${pinnedRecord}\n`);
      },
    });

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV4, pinnedV6],
      request: dial.request,
      resolveTxt: dnsEmpty,
    });

    assert.deepEqual(dial.dialed, [pinnedV4, pinnedV6]);
    assert.equal(result.file.matched, true);
    assert.equal(result.file.error, undefined);
    assert.equal(result.linked, true);
  });

  test("pinned fetch reports timeout when every address times out", async () => {
    const dial = pinnedDial({
      onDial: (_ip, events) => {
        events.timeout();
      },
    });

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV4, pinnedV6],
      request: dial.request,
      resolveTxt: dnsTimeout,
    });

    assert.deepEqual(dial.dialed, [pinnedV4, pinnedV6]);
    assert.equal(result.file.matched, false);
    assert.equal(result.file.error, "Timeout");
    assert.equal(result.dns.error, "Timeout");
    assert.equal(result.linked, false);
    assert.equal(isInconclusiveDomainLinkage(result), true);
  });

  test("pinned fetch tries the next address after a connect error", async () => {
    const dial = pinnedDial({
      onDial: (ip, events) => {
        if (ip === pinnedV4) events.fail();
        else events.respond(200, `${pinnedRecord}\n`);
      },
    });

    const result = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV4, pinnedV6],
      request: dial.request,
      resolveTxt: dnsEmpty,
    });

    assert.deepEqual(dial.dialed, [pinnedV4, pinnedV6]);
    assert.equal(result.file.matched, true);
    assert.equal(result.linked, true);
  });

  test("HTTP non-2xx and an empty allowlist are definitive misses", async () => {
    const missing = pinnedDial({
      onDial: (_ip, events) => {
        events.respond(404, "missing");
      },
    });
    const httpMiss = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV4],
      request: missing.request,
      resolveTxt: dnsTimeout,
    });
    assert.equal(httpMiss.file.error, "HTTP 404");
    assert.equal(httpMiss.linked, false);
    assert.equal(isInconclusiveDomainLinkage(httpMiss), false);

    const empty = pinnedDial({
      onDial: (_ip, events) => {
        events.respond(200, "\n");
      },
    });
    const emptyAllowlist = await verifyProviderDomainLinkage({
      chainPath: "eip155-14",
      identityAddress: pinnedIdentity,
      websiteURL: "https://example.com",
      resolveAddresses: async () => [pinnedV4],
      request: empty.request,
      resolveTxt: dnsEmpty,
    });
    assert.equal(emptyAllowlist.file.matched, false);
    assert.equal(emptyAllowlist.file.error, undefined);
    assert.equal(emptyAllowlist.dns.error, "No TXT records");
    assert.equal(isInconclusiveDomainLinkage(emptyAllowlist), false);
  });
});
