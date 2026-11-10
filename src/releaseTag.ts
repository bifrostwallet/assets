/**
 * The release tag is the package version.
 * The version must be valid semver.
 */

const SEMVER_NUMERIC = "(?:0|[1-9]\\d*)";
const SEMVER_PRE_ID = `(?:${SEMVER_NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
/** Semver 2.0.0, including prerelease and build metadata. */
const SEMVER = new RegExp(
  `^${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}` +
    `(?:-${SEMVER_PRE_ID}(?:\\.${SEMVER_PRE_ID})*)?` +
    "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$",
);

export function isValidSemver(version: string): boolean {
  return SEMVER.test(version);
}

export function releaseTagForVersion(version: string): string {
  if (!isValidSemver(version)) {
    throw new Error(`package.json version ${JSON.stringify(version)} is not valid semver`);
  }
  return version;
}

/**
 * jsDelivr file base for `data/` at one git ref.
 * The release tag is the package version (`@1.0.0`).
 * `main` is the moving branch used by legacy provider all.json.
 */
export function jsDelivrDataBase(owner: string, repo: string, ref: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub owner/repo for jsDelivr: ${owner}/${repo}`);
  }
  if (!ref || /[\s/?#@]/.test(ref)) {
    throw new Error(`jsDelivr ref ${JSON.stringify(ref)} must be a single segment`);
  }
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/data/`;
}

/**
 * The package default must be jsDelivr at this version's release tag, once,
 * directly above `data/`. A branch ref is rejected. A mismatched pin is rejected.
 */
export function assertJsDelivrReleaseBase(base: string, version: string): void {
  const tag = releaseTagForVersion(version);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`Logo base is not a URL: ${base}`);
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.jsdelivr.net") {
    throw new Error(`Logo base must use https://cdn.jsdelivr.net, got ${base}`);
  }
  const match = url.pathname.match(/^\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/data\/$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(
      `Logo base must be https://cdn.jsdelivr.net/gh/<owner>/<repo>@<tag>/data/, got ${base}`,
    );
  }
  if (match[3] !== tag) {
    throw new Error(`Logo base ${base} must pin @${tag} directly above data/`);
  }
  const pins = url.pathname.match(/@/g) ?? [];
  if (pins.length !== 1) {
    throw new Error(`Logo base ${base} must contain exactly one @ release pin`);
  }
}

/**
 * The raw GitHub base must contain the release tag as its own path segment
 * directly above `data/`, once.
 */
export function assertGithubAssetBasePinsReleaseTag(base: string, version: string): void {
  const tag = releaseTagForVersion(version);
  const segments = new URL(base).pathname.split("/").filter((part) => part.length > 0);
  const versionSegments = segments.filter((part) => part === tag);
  if (versionSegments.length !== 1) {
    throw new Error(`GITHUB_ASSET_BASE_URL ${base} must contain exactly one /${tag}/ segment`);
  }
  const dataIndex = segments.lastIndexOf("data");
  if (dataIndex < 1 || segments[dataIndex - 1] !== tag) {
    throw new Error(`GITHUB_ASSET_BASE_URL ${base} must pin ${tag} directly above data/`);
  }
}
