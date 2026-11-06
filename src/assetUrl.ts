import { DEFAULT_ASSET_BASE_URL } from "./config.js";

/**
 * Asset URL helpers.
 *
 * Per-entry info.json and the npm package keep a relative logoURL.
 * Provider all.json uses absolute GitHub raw logo URLs so fetching it renders
 * logos. Tokens have no all.json; the package is the token catalog.
 * An already-absolute logoURL is stripped to its asset path before that join,
 * so it is not double-prefixed. The static bucket upload sends logo files only.
 *
 * resolveAssetURL joins a relative logoURL to the caller's base, and rebases
 * an absolute logoURL that uses a known asset prefix onto that base.
 * Operators publishing to their own host set ASSET_BASE_URL, for example:
 *   ASSET_BASE_URL=https://cdn.example.com/<prefix>/
 */
export function getAssetBaseURL(): string {
  const fromEnv = process.env.ASSET_BASE_URL?.trim();
  // Empty / unset → GitHub raw. (Avoid `env = undefined` — Node stringifies it to "undefined".)
  const base = fromEnv ? fromEnv : DEFAULT_ASSET_BASE_URL;
  return base.replace(/\/?$/, "/");
}

const ASSET_PATH = /((?:providers|dapps|tokens|contracts)\/[^?#]+)/;
const HTTPS_URL = /^https:\/\//i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isHttpsUrl(value: string): boolean {
  return HTTPS_URL.test(value.trim());
}

/**
 * https URLs are reduced to a repo-relative asset path when they use a known
 * prefix. Any other scheme throws, so an http URL cannot be stored or rebased.
 * A path with no scheme loses one leading slash.
 */
export function toRelativeAssetPath(logoURL: string): string {
  const trimmed = logoURL.trim();
  if (isHttpsUrl(trimmed)) {
    try {
      const { pathname } = new URL(trimmed);
      for (const marker of ["/static/", "/data/"]) {
        const idx = pathname.indexOf(marker);
        if (idx !== -1) {
          return pathname.slice(idx + marker.length).replace(/^\//, "");
        }
      }
    } catch {
      // fall through
    }

    const match = trimmed.match(ASSET_PATH);
    return match?.[1] ?? trimmed;
  }
  if (URL_SCHEME.test(trimmed)) {
    throw new Error(`Asset URL must start with https://, got ${JSON.stringify(logoURL)}`);
  }
  return trimmed.replace(/^\//, "");
}

/**
 * Join `logoURL` to `baseURL`.
 * A passed base must start with `https://`. A blank or omitted base uses
 * {@link getAssetBaseURL}, which is GitHub raw unless `ASSET_BASE_URL` is set.
 * Relative paths are appended. An absolute `https://` URL on a known asset
 * prefix is stripped and rebased. Any other absolute `https://` URL is
 * returned unchanged. `http://` and other schemes throw.
 */
export function resolveAssetURL(logoURL: string, baseURL?: string): string {
  const supplied = baseURL === undefined ? "" : String(baseURL).trim();
  const chosen = supplied ? supplied : getAssetBaseURL();
  if (!isHttpsUrl(chosen)) {
    throw new Error(`Asset base must start with https://, got ${JSON.stringify(chosen)}`);
  }
  const base = chosen.replace(/\/?$/, "/");
  const relative = toRelativeAssetPath(logoURL);
  if (isHttpsUrl(relative)) {
    return relative;
  }
  return `${base}${relative.replace(/^\//, "")}`;
}

/** Rewrite logoURL onto the active asset base (in-repo provider all.json). */
export function withAbsoluteLogoURL<T extends { logoURL: string }>(
  entry: T,
  baseURL = getAssetBaseURL(),
): T {
  return { ...entry, logoURL: resolveAssetURL(entry.logoURL, baseURL) };
}

/** Repo-relative logoURL for the npm package. */
export function withRelativeLogoURL<T extends { logoURL: string }>(entry: T): T {
  return { ...entry, logoURL: toRelativeAssetPath(entry.logoURL) };
}
