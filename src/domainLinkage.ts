/**
 * Provider website ↔ identity domain linkage checks.
 *
 * Used by nightly CI (`sync:domain-linkage` / refresh). Security posture:
 * - Never follow HTTP redirects.
 * - Fetch only `https://<hostname>/.well-known/providers.txt` (no user path/query/port).
 * - Reject platform default hosts (vercel.app, run.app, amazonaws.com, …); own domain only.
 * - Resolve DNS; refuse ANY non-public IP (incl. GCP metadata 169.254.169.254 / VPC).
 * - Default path dials pre-validated public IPs only (no DNS rebinding at connect).
 * - Stream body with a hard byte cap; parse only allowlisted CAIP-10 tokens.
 */

import * as dns from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { isPlatformWebsiteHostname } from "./validate.js";

/** Well-known path published by providers */
export const DOMAIN_LINKAGE_WELL_KNOWN_PATH = "/.well-known/providers.txt";

/** DNS label for TXT proofs (`_providers.<website-host>`) */
export const DOMAIN_LINKAGE_DNS_LABEL = "_providers";

/** Hard cap on well-known body bytes (stream-aborted past this). */
export const DOMAIN_LINKAGE_MAX_FILE_BYTES = 4 * 1024;

/** Cap total DNS TXT payload we parse. */
export const DOMAIN_LINKAGE_MAX_TXT_BYTES = 4 * 1024;

/** Fetch / DNS timeout */
export const DOMAIN_LINKAGE_FETCH_TIMEOUT_MS = 5_000;
export const DOMAIN_LINKAGE_DNS_TIMEOUT_MS = 5_000;

/**
 * Allowlisted linkage record: CAIP-2 chain + identity (hex case-insensitive).
 * Example: eip155:14:0xabc…def
 *
 * Canonical published form (same for `/.well-known/providers.txt` and DNS TXT):
 *   eip155:14:0x…,eip155:19:0x…
 * Separators may be comma, semicolon, and/or whitespace (including newlines).
 * Trailing separators and surrounding spaces are ignored. Hex is matched
 * case-insensitively and stored lowercase. Other tokens are ignored.
 */
export const DOMAIN_LINKAGE_RECORD_RE = /^eip155:(14|19):0x[0-9a-fA-F]{40}$/;

const DOMAIN_LINKAGE_SEPARATOR_RE = /[,;\s]+/;
const PUBLIC_HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "kubernetes",
  "kubernetes.default",
  "kubernetes.default.svc",
  "kubernetes.default.svc.cluster.local",
]);

export function chainPathToCaip2(chainPath: string): string {
  return chainPath.replace("-", ":");
}

export function expectedDomainLinkageRecord(chainPath: string, identityAddress: string): string {
  const caip2 = chainPathToCaip2(chainPath);
  const identity = identityAddress.toLowerCase();
  const record = `${caip2}:${identity}`;
  if (!DOMAIN_LINKAGE_RECORD_RE.test(record)) {
    throw new Error(`Invalid domain linkage record: ${record}`);
  }
  return record;
}

export function dnsLinkageName(hostname: string): string {
  return `${DOMAIN_LINKAGE_DNS_LABEL}.${hostname}`;
}

function normalizeLinkageRecord(token: string): string | null {
  const trimmed = token.trim();
  if (!DOMAIN_LINKAGE_RECORD_RE.test(trimmed)) return null;
  const match = trimmed.match(/^eip155:(14|19):0x([0-9a-fA-F]{40})$/);
  if (!match) return null;
  return `eip155:${match[1]}:0x${match[2].toLowerCase()}`;
}

/**
 * Strip `#` line comments, then split on comma / semicolon / whitespace.
 * Same rules for the well-known file body and DNS TXT payload(s).
 */
export function extractAllowlistedRecords(text: string): Set<string> {
  const withoutComments = text
    .split(/\r?\n/)
    .map((line) => {
      const hash = line.indexOf("#");
      return (hash === -1 ? line : line.slice(0, hash)).trimEnd();
    })
    .join("\n");

  const found = new Set<string>();
  for (const token of withoutComments.split(DOMAIN_LINKAGE_SEPARATOR_RE)) {
    if (!token) continue;
    const normalized = normalizeLinkageRecord(token);
    if (normalized) found.add(normalized);
  }
  return found;
}

/**
 * Flatten DNS TXT answers (including multi-string chunks) into one payload and
 * parse with the same rules as the well-known file. Caps total bytes parsed.
 */
export function extractAllowlistedRecordsFromTxt(answers: string[][]): Set<string> {
  let total = 0;
  const parts: string[] = [];
  for (const chunks of answers) {
    const joined = chunks.join("");
    if (total + joined.length > DOMAIN_LINKAGE_MAX_TXT_BYTES) {
      parts.push(joined.slice(0, DOMAIN_LINKAGE_MAX_TXT_BYTES - total));
      break;
    }
    parts.push(joined);
    total += joined.length;
  }
  return extractAllowlistedRecords(parts.join(","));
}

/** Reject IP literals, platform defaults, and non-public DNS names before any network I/O. */
export function isAllowedPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.length < 1 || host.length > 253) return false;
  if (host.endsWith(".")) return false;
  if (isIP(host) !== 0) return false;
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".corp")) return false;
  if (host.endsWith(".google.internal")) return false;
  if (!PUBLIC_HOSTNAME_RE.test(host)) return false;
  if (isPlatformWebsiteHostname(host)) return false;
  return true;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value << 8) + n;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return true;
  if (prefix < 0 || prefix > 32) return true;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isBlockedIpv4(ip: string): boolean {
  if (ipv4InCidr(ip, "169.254.0.0", 16)) return true; // link-local + cloud metadata
  if (ipv4InCidr(ip, "10.0.0.0", 8)) return true;
  if (ipv4InCidr(ip, "172.16.0.0", 12)) return true;
  if (ipv4InCidr(ip, "192.168.0.0", 16)) return true;
  if (ipv4InCidr(ip, "127.0.0.0", 8)) return true;
  if (ipv4InCidr(ip, "0.0.0.0", 8)) return true;
  if (ipv4InCidr(ip, "100.64.0.0", 10)) return true;
  if (ipv4InCidr(ip, "192.0.0.0", 24)) return true;
  if (ipv4InCidr(ip, "192.0.2.0", 24)) return true;
  if (ipv4InCidr(ip, "198.51.100.0", 24)) return true;
  if (ipv4InCidr(ip, "203.0.113.0", 24)) return true;
  if (ipv4InCidr(ip, "198.18.0.0", 15)) return true;
  if (ipv4InCidr(ip, "224.0.0.0", 4)) return true;
  if (ipv4InCidr(ip, "240.0.0.0", 4)) return true;
  return false;
}

function parseIpv6Words(ip: string): number[] | null {
  const input = ip.toLowerCase();
  if (input.includes(".")) return null;
  const sides = input.split("::");
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const tail = sides.length === 2 && sides[1] ? sides[1].split(":").filter(Boolean) : [];
  if (sides.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 8) {
    return null;
  }
  const mid = sides.length === 2 ? 8 - head.length - tail.length : 0;
  const words: number[] = [];
  for (const part of head) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  for (let i = 0; i < mid; i++) words.push(0);
  for (const part of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words.length === 8 ? words : null;
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const v4mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4mapped?.[1]) return isBlockedIpv4(v4mapped[1]);

  const words = parseIpv6Words(normalized);
  if (!words) return true;

  const w0 = words[0] ?? 0;
  const w1 = words[1] ?? 0;
  const w2 = words[2] ?? 0;
  const w3 = words[3] ?? 0;
  const w4 = words[4] ?? 0;
  const w5 = words[5] ?? 0;
  const w6 = words[6] ?? 0;
  const w7 = words[7] ?? 0;

  if (words.every((w) => w === 0)) return true;
  if (words.slice(0, 7).every((w) => w === 0) && w7 === 1) return true;
  if ((w0 & 0xffc0) === 0xfe80) return true;
  if ((w0 & 0xfe00) === 0xfc00) return true;
  if ((w0 & 0xff00) === 0xff00) return true;
  if (w0 === 0x2001 && w1 === 0xdb8) return true;
  if (w0 === 0x2001 && w1 === 0x2) return true;
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    const embedded = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
    return isBlockedIpv4(embedded);
  }
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  return false;
}

/** True if the address must never be contacted (SSRF / metadata / VPC). */
export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isBlockedIpv4(ip);
  if (version === 6) return isBlockedIpv6(ip);
  return true;
}

export async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (!isAllowedPublicHostname(hostname)) {
    throw new Error("BLOCKED_HOST");
  }
  const [v4, v6] = await Promise.all([
    dns.resolve4(hostname).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [] as string[];
      throw error;
    }),
    dns.resolve6(hostname).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENODATA" || error.code === "ENOTFOUND") return [] as string[];
      throw error;
    }),
  ]);
  const addrs = [...v4, ...v6];
  if (addrs.length === 0) throw new Error("NXDOMAIN");
  const publicAddrs = addrs.filter((addr) => !isBlockedIpAddress(addr));
  if (publicAddrs.length !== addrs.length) throw new Error("BLOCKED_IP");
  return publicAddrs;
}

export function publicHostnameFromWebsiteURL(websiteURL: string): string | null {
  try {
    const url = new URL(websiteURL);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.port !== "") return null;
    if (url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (!isAllowedPublicHostname(hostname)) return null;
    return hostname;
  } catch {
    return null;
  }
}

type PinnedHttpResult = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

/** Dial only pre-validated public IPs; SNI/Host use the public hostname. No redirects. */
function httpsGetPinned(args: {
  hostname: string;
  publicIps: string[];
  path: string;
  timeoutMs: number;
}): Promise<PinnedHttpResult> {
  const { hostname, publicIps, path, timeoutMs } = args;
  if (publicIps.length === 0 || publicIps.some((ip) => isBlockedIpAddress(ip))) {
    return Promise.reject(new Error("BLOCKED_IP"));
  }
  if (path !== DOMAIN_LINKAGE_WELL_KNOWN_PATH) {
    return Promise.reject(new Error("BAD_PATH"));
  }

  const ordered = [
    ...publicIps.filter((ip) => isIP(ip) === 4),
    ...publicIps.filter((ip) => isIP(ip) === 6),
  ];

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;

    const tryNext = () => {
      const ip = ordered[attempt];
      attempt += 1;
      if (!ip) {
        if (!settled) {
          settled = true;
          reject(new Error("CONNECT_FAILED"));
        }
        return;
      }
      if (isBlockedIpAddress(ip)) {
        tryNext();
        return;
      }

      const req = https.request(
        {
          host: ip,
          servername: hostname,
          port: 443,
          method: "GET",
          path,
          setHost: false,
          headers: {
            Host: hostname,
            Accept: "text/plain",
            "Accept-Encoding": "identity",
            Connection: "close",
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let tooLarge = false;

          const contentLength = res.headers["content-length"];
          if (typeof contentLength === "string") {
            const declared = Number(contentLength);
            if (
              !Number.isFinite(declared) ||
              declared < 0 ||
              declared > DOMAIN_LINKAGE_MAX_FILE_BYTES
            ) {
              tooLarge = true;
              res.destroy();
              if (!settled) {
                settled = true;
                resolve({ status: 494, headers: res.headers, body: Buffer.alloc(0) });
              }
              return;
            }
          }

          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > DOMAIN_LINKAGE_MAX_FILE_BYTES) {
              tooLarge = true;
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          // A local destroy() emits neither "end" nor "error"; without this the
          // promise never settles and Node exits silently on an empty event loop.
          res.on("close", () => {
            if (settled || !tooLarge) return;
            settled = true;
            resolve({ status: 494, headers: res.headers, body: Buffer.alloc(0) });
          });
          res.on("end", () => {
            if (settled) return;
            settled = true;
            resolve({
              status: tooLarge ? 494 : (res.statusCode ?? 0),
              headers: res.headers,
              body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks),
            });
          });
          res.on("error", () => {
            if (!settled) tryNext();
          });
        },
      );

      req.on("timeout", () => {
        req.destroy();
        if (!settled) {
          settled = true;
          reject(new Error("TIMEOUT"));
        }
      });
      req.on("error", () => {
        if (!settled) tryNext();
      });
      req.end();
    };

    tryNext();
  });
}

async function readFetchBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      return { ok: false, error: `File exceeds ${maxBytes} bytes` };
    }
  }
  if (!response.body) return { ok: true, bytes: Buffer.alloc(0) };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: `File exceeds ${maxBytes} bytes` };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Read failed" };
  }
  return { ok: true, bytes: Buffer.concat(chunks.map((c) => Buffer.from(c))) };
}

export interface DomainLinkageCheck {
  chainPath: string;
  identityAddress: string;
  websiteURL: string;
  expectedRecord: string;
  file: {
    checked: boolean;
    matched: boolean;
    error?: string;
  };
  dns: {
    checked: boolean;
    matched: boolean;
    name: string;
    error?: string;
  };
  linked: boolean;
}

async function fetchWellKnownViaPinned(args: {
  hostname: string;
  expectedRecord: string;
}): Promise<{ matched: boolean; present: boolean; error?: string }> {
  try {
    const publicIps = await resolvePublicAddresses(args.hostname);
    const result = await httpsGetPinned({
      hostname: args.hostname,
      publicIps,
      path: DOMAIN_LINKAGE_WELL_KNOWN_PATH,
      timeoutMs: DOMAIN_LINKAGE_FETCH_TIMEOUT_MS,
    });

    if (result.status >= 300 && result.status < 400) {
      return { matched: false, present: false, error: "Redirect not followed" };
    }
    if (result.status === 494) {
      return {
        matched: false,
        present: false,
        error: `File exceeds ${DOMAIN_LINKAGE_MAX_FILE_BYTES} bytes`,
      };
    }
    if (!result.status || result.status < 200 || result.status >= 300) {
      return { matched: false, present: false, error: `HTTP ${result.status || 0}` };
    }

    const contentTypeHeader = String(result.headers["content-type"] ?? "text/plain").toLowerCase();
    const mediaType = contentTypeHeader.split(";")[0]?.trim() ?? "";
    if (mediaType !== "text/plain" && mediaType !== "application/octet-stream") {
      return { matched: false, present: false, error: "Disallowed Content-Type" };
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.body);
    } catch {
      return { matched: false, present: false, error: "Invalid UTF-8" };
    }
    const records = extractAllowlistedRecords(text);
    return {
      matched: records.has(args.expectedRecord),
      present: records.size > 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "BLOCKED_IP" || message === "BLOCKED_HOST" || message === "NXDOMAIN") {
      return { matched: false, present: false, error: "websiteURL host is not allowed" };
    }
    if (message === "TIMEOUT") {
      return { matched: false, present: false, error: "Timeout" };
    }
    return { matched: false, present: false, error: "Fetch failed" };
  }
}

/** Test/injection path: still hostname-gated and size-capped; never follows redirects. */
async function fetchWellKnownViaFetchImpl(args: {
  hostname: string;
  expectedRecord: string;
  fetchImpl: typeof fetch;
}): Promise<{ matched: boolean; present: boolean; error?: string }> {
  try {
    const fileURL = `https://${args.hostname}${DOMAIN_LINKAGE_WELL_KNOWN_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOMAIN_LINKAGE_FETCH_TIMEOUT_MS);
    const response = await args.fetchImpl(fileURL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      // Do not echo Location — fixed message only.
      return { matched: false, present: false, error: "Redirect not followed" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { matched: false, present: false, error: `HTTP ${response.status}` };
    }

    const contentTypeHeader = (response.headers.get("content-type") ?? "text/plain").toLowerCase();
    const mediaType = contentTypeHeader.split(";")[0]?.trim() ?? "";
    if (mediaType !== "text/plain" && mediaType !== "application/octet-stream") {
      await response.body?.cancel().catch(() => undefined);
      return { matched: false, present: false, error: "Disallowed Content-Type" };
    }

    const body = await readFetchBodyCapped(response, DOMAIN_LINKAGE_MAX_FILE_BYTES);
    if (!body.ok) return { matched: false, present: false, error: body.error };

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
    } catch {
      return { matched: false, present: false, error: "Invalid UTF-8" };
    }
    const records = extractAllowlistedRecords(text);
    return {
      matched: records.has(args.expectedRecord),
      present: records.size > 0,
    };
  } catch (error) {
    return {
      matched: false,
      present: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveDnsRecords(args: {
  name: string;
  expectedRecord: string;
  resolveTxt: (hostname: string) => Promise<string[][]>;
}): Promise<{ matched: boolean; present: boolean; error?: string }> {
  try {
    const hostPart = args.name.startsWith(`${DOMAIN_LINKAGE_DNS_LABEL}.`)
      ? args.name.slice(DOMAIN_LINKAGE_DNS_LABEL.length + 1)
      : "";
    if (!hostPart || !isAllowedPublicHostname(hostPart)) {
      return { matched: false, present: false, error: "websiteURL host is not allowed" };
    }

    const answers = await Promise.race([
      args.resolveTxt(args.name),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error("Timeout"), { code: "ETIMEOUT" })),
          DOMAIN_LINKAGE_DNS_TIMEOUT_MS,
        );
      }),
    ]);
    const records = extractAllowlistedRecordsFromTxt(answers);
    return {
      matched: records.has(args.expectedRecord),
      present: records.size > 0,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "ENODATA" || code === "ENOTFOUND") {
      return { matched: false, present: false, error: "No TXT records" };
    }
    if (code === "ETIMEOUT") {
      return { matched: false, present: false, error: "Timeout" };
    }
    return {
      matched: false,
      present: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify domain linkage for one provider using only their curated websiteURL.
 * Always checks both `/.well-known/providers.txt` and `_providers.<host>` TXT.
 * Linked if ≥1 method matches the expected identity token. If both sides return
 * parseable allowlisted payloads, they must agree on the expected token
 * (contradiction → not linked).
 *
 * `fetchImpl` is for tests only — production uses IP-pinned HTTPS.
 */
export async function verifyProviderDomainLinkage(args: {
  chainPath: string;
  identityAddress: string;
  websiteURL: string;
  fetchImpl?: typeof fetch;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
}): Promise<DomainLinkageCheck> {
  const identity = args.identityAddress.toLowerCase();
  const expectedRecord = expectedDomainLinkageRecord(args.chainPath, identity);
  const resolveTxt = args.resolveTxt ?? ((name) => dns.resolveTxt(name));

  const result: DomainLinkageCheck = {
    chainPath: args.chainPath,
    identityAddress: identity,
    websiteURL: args.websiteURL,
    expectedRecord,
    file: { checked: false, matched: false },
    dns: { checked: false, matched: false, name: "" },
    linked: false,
  };

  const hostname = publicHostnameFromWebsiteURL(args.websiteURL);
  if (!hostname) {
    const message = "websiteURL host is not allowed";
    result.file.error = message;
    result.dns.error = message;
    return result;
  }

  result.dns.name = dnsLinkageName(hostname);

  result.file.checked = true;
  const fileResult = args.fetchImpl
    ? await fetchWellKnownViaFetchImpl({
        hostname,
        expectedRecord,
        fetchImpl: args.fetchImpl,
      })
    : await fetchWellKnownViaPinned({ hostname, expectedRecord });
  result.file.matched = fileResult.matched;
  if (!fileResult.matched) {
    result.file.error = fileResult.error;
  }

  result.dns.checked = true;
  const dnsResult = await resolveDnsRecords({
    name: result.dns.name,
    expectedRecord,
    resolveTxt,
  });
  result.dns.matched = dnsResult.matched;
  if (!dnsResult.matched) {
    result.dns.error = dnsResult.error;
  }

  if (fileResult.present && dnsResult.present && result.file.matched !== result.dns.matched) {
    result.linked = false;
    const contradiction = "File and DNS linkage records contradict for this identity";
    if (result.file.matched) result.dns.error = contradiction;
    else result.file.error = contradiction;
    return result;
  }

  result.linked = result.file.matched || result.dns.matched;
  return result;
}
