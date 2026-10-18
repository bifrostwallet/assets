import { DEFAULT_ASSET_BASE_URL } from "./config.js";

/**
 * Logo hosting base for published lists (all.json / NPM package / CDN upload).
 *
 * Per-provider info.json keeps a relative logoURL (signature / intake).
 * Aggregates expand to an absolute URL so JSON can be consumed as-is.
 *
 * Operators publishing to their own host override with ASSET_BASE_URL, e.g.:
 *   ASSET_BASE_URL=https://cdn.example.com/<prefix>/
 */
export function getAssetBaseURL(): string {
  const fromEnv = process.env.ASSET_BASE_URL?.trim();
  // Empty / unset → GitHub raw. (Avoid `env = undefined` — Node stringifies it to "undefined".)
  const base = fromEnv ? fromEnv : DEFAULT_ASSET_BASE_URL;
  return base.replace(/\/?$/, "/");
}

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

  const match = trimmed.match(/((?:providers|dapps|tokens|contracts|projects)\/.+)$/);
  return match ? match[1] : trimmed.replace(/^\//, "");
}

export function resolveAssetURL(relativePath: string, baseURL = getAssetBaseURL()): string {
  const base = baseURL.replace(/\/?$/, "/");
  const relative = toRelativeAssetPath(relativePath);
  return `${base}${relative.replace(/^\//, "")}`;
}

/** Rewrite logoURL onto the active asset base (idempotent / re-hostable). */
export function withAbsoluteLogoURL<T extends { logoURL: string }>(
  entry: T,
  baseURL = getAssetBaseURL(),
): T {
  return { ...entry, logoURL: resolveAssetURL(entry.logoURL, baseURL) };
}
