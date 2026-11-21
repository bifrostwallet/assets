import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { crc32cBase64 } from "./crc32c.js";

/**
 * Minimal Cloud Storage client over fetch (JSON API). Covers what
 * pull:submissions needs: list a bucket and read an object. It has no write or
 * delete: this repository only downloads.
 *
 * Auth is an OAuth access token:
 * - GCS_ACCESS_TOKEN when set. The pull-submissions workflow passes the token
 *   that google-github-actions/auth mints through Workload Identity Federation.
 * - Otherwise `gcloud auth print-access-token`, for local runs.
 *
 * Hardening kept from the client library this replaces:
 * - Downloads are checked against the CRC32C GCS reports for the object.
 * - Transient failures (408, 429, 5xx, network errors, timeouts) are retried.
 * - Every request has the library's 60-second timeout.
 * Added:
 * - Redirects are never followed, so the token only goes to the fixed host.
 * - Reads can be pinned to a generation, so an object replaced after it was
 *   listed is not read in its place.
 */

const STORAGE_ORIGIN = "https://storage.googleapis.com";

/** Per-attempt cap for every request, body included. Same as the client library. */
export const GCS_TIMEOUT_MS = 60_000;

/** Attempts after the first for 408, 429, 5xx, network errors, and timeouts. */
export const GCS_MAX_RETRIES = 3;

/** First retry waits this long, then 2× (1s, 2s, 4s). */
export const GCS_RETRY_BACKOFF_MS = 1_000;

export class GcsHttpError extends Error {
  public readonly status: number;

  public constructor(status: number, action: string) {
    super(`GCS ${action} failed with HTTP ${status}`);
    this.name = "GcsHttpError";
    this.status = status;
  }
}

/** Downloaded bytes do not match the CRC32C GCS reports for the object. */
export class GcsIntegrityError extends Error {
  public constructor() {
    super("GCS read failed: content does not match the object CRC32C");
    this.name = "GcsIntegrityError";
  }
}

/** GCS answered 2xx with a body this client does not understand. Retrying returns the same. */
export class GcsResponseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GcsResponseError";
  }
}

/** The object is larger than the caller allows. */
export class GcsObjectTooLargeError extends Error {
  public constructor(maxBytes: number) {
    super(`GCS read failed: object exceeds ${maxBytes} bytes`);
    this.name = "GcsObjectTooLargeError";
  }
}

export interface GcsObject {
  name: string;
  size: number;
  generation: string;
}

export interface GcsDownloadOptions {
  /** Read this generation only. A newer write makes the read return undefined. */
  generation?: string;
  /** Reject the object when it is larger than this. */
  maxBytes?: number;
}

export interface GcsClient {
  /** Every object in the bucket, across all pages. */
  list(bucket: string): Promise<GcsObject[]>;
  /** Object bytes, or undefined when the object (or the requested generation) is absent. */
  download(
    bucket: string,
    objectKey: string,
    options?: GcsDownloadOptions,
  ): Promise<Buffer | undefined>;
}

export interface AccessTokenSource {
  /** A token for the next request. `refresh` asks for a new one after a 401. */
  token(refresh: boolean): Promise<string>;
  /** False when a rejected token cannot be replaced, so a 401 is final. */
  readonly refreshable: boolean;
}

export interface GcsClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  tokenSource?: AccessTokenSource;
}

const execFileAsync = promisify(execFile);

/** GCS_ACCESS_TOKEN when set, else `gcloud auth print-access-token`. */
export function defaultTokenSource(env: NodeJS.ProcessEnv = process.env): AccessTokenSource {
  const fromEnv = env.GCS_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    return { refreshable: false, token: async () => fromEnv };
  }
  let cached: Promise<string> | undefined;
  const fromGcloud = async (): Promise<string> => {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"], {
      timeout: GCS_TIMEOUT_MS,
    });
    const token = stdout.trim();
    if (!token) {
      throw new Error("gcloud auth print-access-token returned no token");
    }
    return token;
  };
  return {
    refreshable: true,
    token(refresh) {
      if (refresh || !cached) {
        cached = fromGcloud().catch((error: unknown) => {
          cached = undefined;
          throw new Error(
            "No GCS access token. Set GCS_ACCESS_TOKEN or sign in with `gcloud auth login`.",
            { cause: error },
          );
        });
      }
      return cached;
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Anything that is not an HTTP status: undici network failures and timeouts. */
function isTransientFailure(error: unknown): boolean {
  if (error instanceof GcsHttpError) {
    return isTransientStatus(error.status);
  }
  // The stored object is what is wrong, so another read returns the same bytes.
  if (
    error instanceof GcsIntegrityError ||
    error instanceof GcsObjectTooLargeError ||
    error instanceof GcsResponseError
  ) {
    return false;
  }
  return true;
}

/**
 * CRC32C of the stored object from `x-goog-hash` (`crc32c=...,md5=...`), or
 * undefined when it cannot be compared with the bytes received: GCS sent no
 * checksum, or the object is stored compressed and fetch already decoded it,
 * so the checksum covers different bytes.
 */
function comparableCrc32c(headers: Headers): string | undefined {
  const storedEncoding = headers.get("x-goog-stored-content-encoding");
  if (storedEncoding !== null && storedEncoding !== "identity") {
    return undefined;
  }
  return headers.get("x-goog-hash")?.match(/(?:^|,)\s*crc32c=([A-Za-z0-9+/=]+)/)?.[1];
}

function objectUrl(bucket: string, objectKey: string): string {
  return `${STORAGE_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectKey)}`;
}

function parseListPage(body: unknown): { items: GcsObject[]; nextPageToken?: string } {
  if (typeof body !== "object" || body === null) {
    throw new GcsResponseError("GCS list returned a non-object body");
  }
  const { items, nextPageToken } = body as { items?: unknown; nextPageToken?: unknown };
  const objects: GcsObject[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const { name, size, generation } = (item ?? {}) as Record<string, unknown>;
    // The JSON API sends size and generation as decimal strings.
    if (typeof name !== "string" || typeof size !== "string" || typeof generation !== "string") {
      throw new GcsResponseError("GCS list returned an item without name, size, and generation");
    }
    objects.push({ name, size: Number(size), generation });
  }
  return {
    items: objects,
    nextPageToken: typeof nextPageToken === "string" && nextPageToken ? nextPageToken : undefined,
  };
}

export function createGcsClient(deps: GcsClientDeps = {}): GcsClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const tokenSource = deps.tokenSource ?? defaultTokenSource();

  /**
   * Sends an authenticated request, retrying transient failures. A 2xx response,
   * or one with a status in `passThrough`, is handed to `consume` inside the
   * same attempt, so a connection that drops or times out while the body is
   * being read is retried too. Throws otherwise.
   */
  async function send<T>(
    action: string,
    url: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    passThrough: readonly number[] = [],
  ): Promise<T> {
    let lastError: unknown;
    let refreshToken = false;
    for (let attempt = 0; attempt <= GCS_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(GCS_RETRY_BACKOFF_MS * 2 ** (attempt - 1));
      }
      try {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${await tokenSource.token(refreshToken)}`);
        refreshToken = false;
        const response = await fetchImpl(url, {
          ...init,
          headers,
          // A redirect comes back as its 3xx and fails below, so the token never leaves this host.
          redirect: "manual",
          signal: AbortSignal.timeout(GCS_TIMEOUT_MS),
        });
        if (response.ok || passThrough.includes(response.status)) {
          return await consume(response);
        }
        await response.body?.cancel();
        if (response.status === 401 && tokenSource.refreshable) {
          // The token was rejected. Ask for a new one on the next attempt.
          refreshToken = true;
          lastError = new GcsHttpError(401, action);
          continue;
        }
        throw new GcsHttpError(response.status, action);
      } catch (error) {
        lastError = error;
        if (!isTransientFailure(error)) {
          break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    async list(bucket) {
      const objects: GcsObject[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({ fields: "items(name,size,generation),nextPageToken" });
        if (pageToken) {
          params.set("pageToken", pageToken);
        }
        const url = `${STORAGE_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`;
        const page = await send("list", url, {}, async (response) =>
          parseListPage(await response.json()),
        );
        objects.push(...page.items);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return objects;
    },

    async download(bucket, objectKey, options = {}) {
      const params = new URLSearchParams({ alt: "media" });
      if (options.generation) {
        params.set("generation", options.generation);
      }
      const { maxBytes } = options;
      return send(
        "read",
        `${objectUrl(bucket, objectKey)}?${params}`,
        {},
        async (response) => {
          if (response.status === 404) {
            await response.body?.cancel();
            return undefined;
          }
          const declared = Number(response.headers.get("content-length"));
          if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
            await response.body?.cancel();
            throw new GcsObjectTooLargeError(maxBytes);
          }
          const data = Buffer.from(await response.arrayBuffer());
          if (maxBytes !== undefined && data.length > maxBytes) {
            throw new GcsObjectTooLargeError(maxBytes);
          }
          const expected = comparableCrc32c(response.headers);
          if (expected !== undefined && expected !== crc32cBase64(data)) {
            throw new GcsIntegrityError();
          }
          return data;
        },
        [404],
      );
    },
  };
}
