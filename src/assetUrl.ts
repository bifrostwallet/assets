import { DEFAULT_ASSET_BASE_URL } from "./config.js";

/**
 * Asset URL helpers.
 *
 * Per-entry info.json and the npm package keep a relative logoURL.
 * Bucket upload rewrites hosted all.json onto ASSET_BASE_URL (GitHub raw
 * when unset). In-repo provider all.json stays absolute for that upload.
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

/** Strip a hosting prefix back to the repo-relative asset path. */
export function toRelativeAssetPath(logoURL: string): string {
  const trimmed = logoURL.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^\//, "");
  }

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

/**
 * Join `logoURL` to `baseURL`.
 * Relative paths are appended. Absolute URLs on a known asset prefix
 * (a `/static/` or `/data/` host prefix, or a providers/tokens/dapps/contracts
 * path) are stripped and rebased. An absolute URL that does not match stays
 * unchanged, so it is not concatenated onto `baseURL`.
 * When `baseURL` is omitted, operator tooling uses {@link getAssetBaseURL}.
 */
export function resolveAssetURL(logoURL: string, baseURL = getAssetBaseURL()): string {
  const chosen = baseURL.trim() ? baseURL : getAssetBaseURL();
  const base = chosen.replace(/\/?$/, "/");
  const relative = toRelativeAssetPath(logoURL);
  if (/^https?:\/\//i.test(relative)) {
    return relative;
  }
  return `${base}${relative.replace(/^\//, "")}`;
}

/** Rewrite logoURL onto the active asset base (bucket upload / provider all.json). */
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
