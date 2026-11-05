/**
 * Release tags are `v` plus the package.json version (`v0.0.5-beta`).
 * The version must already be valid semver and must not include that prefix,
 * so the tag cannot become `vv0.0.6-beta`.
 */

const SEMVER_NUMERIC = "(?:0|[1-9]\\d*)";
const SEMVER_PRE_ID = `(?:${SEMVER_NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
/** Semver 2.0.0, including prerelease and build metadata. No leading `v`. */
const SEMVER = new RegExp(
  `^${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}` +
    `(?:-${SEMVER_PRE_ID}(?:\\.${SEMVER_PRE_ID})*)?` +
    "(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$",
);

export function isValidSemver(version: string): boolean {
  return SEMVER.test(version);
}

export function releaseTagForVersion(version: string): string {
  if (version.startsWith("v")) {
    throw new Error(
      `package.json version must not start with "v" (got ${JSON.stringify(version)}). ` +
        "The release tag adds that prefix.",
    );
  }
  if (!isValidSemver(version)) {
    throw new Error(`package.json version ${JSON.stringify(version)} is not valid semver`);
  }
  const tag = `v${version}`;
  if (tag.startsWith("vv")) {
    throw new Error(`Refusing release tag ${tag}`);
  }
  return tag;
}

/**
 * The raw GitHub base must contain the release tag as its own path segment
 * directly above `data/`, once. `endsWith(`/v${version}/data/`)` still passes
 * when version is `v0.0.6-beta`, because the URL and the check both use `vv0.0.6-beta`.
 */
export function assertGithubAssetBasePinsReleaseTag(base: string, version: string): void {
  const tag = releaseTagForVersion(version);
  if (base.includes("/vv")) {
    throw new Error(`GITHUB_ASSET_BASE_URL ${base} must not contain /vv`);
  }
  const segments = new URL(base).pathname.split("/").filter((part) => part.length > 0);
  const versionSegments = segments.filter(
    (part) => part.startsWith("v") && isValidSemver(part.slice(1)),
  );
  if (versionSegments.length !== 1 || versionSegments[0] !== tag) {
    throw new Error(`GITHUB_ASSET_BASE_URL ${base} must contain exactly one /${tag}/ segment`);
  }
  const dataIndex = segments.lastIndexOf("data");
  if (dataIndex < 1 || segments[dataIndex - 1] !== tag) {
    throw new Error(`GITHUB_ASSET_BASE_URL ${base} must pin ${tag} directly above data/`);
  }
}
