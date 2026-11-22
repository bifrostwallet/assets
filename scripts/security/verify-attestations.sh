#!/bin/sh

# Registry signatures and build attestations (npm provenance) of every package
# in yarn.lock. POSIX sh entrypoint with an embedded Node program.
#
#   ./yarn security:verify-attestations          check
#   ./yarn security:verify-attestations:update   record new packages in the baseline
#
# Needs the network (registry.npmjs.org and the Sigstore TUF repository), so it
# is NOT part of security-checks.sh. CI runs it when yarn.lock changes
# (.github/workflows/attestations.yml). Its rules are tested offline by
# verify-attestations-fixtures.sh.
#
# The cryptographic verification is not written here. It is done by the
# verifier inside the npm that ships with the pinned Node (pacote + sigstore,
# the code behind `npm audit signatures`), loaded from the Node installation,
# never from this repository's dependencies. See base-repository
# docs/security-scripts.md:
# https://github.com/TowoLabs/base-repository/blob/main/docs/security-scripts.md
#
# Fails when:
#   - a registry signature is missing or invalid
#   - an attestation is invalid
#   - a locked package is not on the public registry
#   - a provenance statement names another repository than its signing
#     certificate
#   - a package in the baseline has no provenance at a version at or above the
#     one the baseline first saw it with (provenance was dropped)
#   - a package's provenance names another source repository than the baseline
#   - the baseline (package-attestations.json) is out of date
#
# Packages that publish no provenance are counted, and listed when they are
# direct dependencies. Packages that .yarnrc.yml takes from another registry
# are listed as not checked. Provenance says where a package was built, not that it
# is safe.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

MODE=${1:-check}
case "$MODE" in
  check | update) ;;
  *)
    printf '%b\n' "${RED}Usage: $0 [check|update]${NC}" >&2
    exit 64
    ;;
esac

if [ ! -f "yarn.lock" ]; then
  printf '%b\n' "${RED}Error: yarn.lock is missing. Run from the repository root.${NC}" >&2
  exit 1
fi

WORK_DIR=$(mktemp -d)
# EXIT cleans the temp Node program and TUF cache. INT/TERM must exit explicitly under POSIX.
trap 'rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat >"$WORK_DIR/verify.cjs" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [mode, workDir] = process.argv.slice(2);
const BASELINE = "package-attestations.json";
const REGISTRY = "https://registry.npmjs.org/";
// Yarn's default server is an alias of the npm registry.
const PUBLIC_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);
// Fulcio certificate extension: Source Repository URI.
const OID_SOURCE_REPOSITORY = "1.3.6.1.4.1.57264.1.12";
const CONCURRENCY = 16;
const PROVENANCE_PREFIX = "https://slsa.dev/provenance/";
const INVALID_CODES = new Set([
  "EINTEGRITYSIGNATURE",
  "EATTESTATIONVERIFY",
  "EATTESTATIONSUBJECT",
  "EMISSINGSIGNATUREKEY",
  "EEXPIREDSIGNATUREKEY",
]);

/** The npm next to the running Node. Its bundled packages do the verification. */
function loadNpm() {
  const candidates = [
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm"),
    path.join(path.dirname(process.execPath), "node_modules", "npm"),
  ];
  for (const root of candidates) {
    const manifest = path.join(root, "package.json");
    if (!fs.existsSync(manifest)) continue;
    if (JSON.parse(fs.readFileSync(manifest, "utf8")).name !== "npm") continue;
    const fromNpm = createRequire(manifest);
    return {
      version: fromNpm("./package.json").version,
      pacote: fromNpm("pacote"),
      sigstore: fromNpm("sigstore"),
      tuf: fromNpm("@sigstore/tuf"),
      X509Certificate: fromNpm("@sigstore/core").X509Certificate,
      fetch: fromNpm("npm-registry-fetch"),
      semver: fromNpm("semver"),
    };
  }
  throw new Error(
    "Cannot find the npm that ships with Node next to " +
      process.execPath +
      ". Use an official Node build (nvm, fnm, actions/setup-node).",
  );
}

function isPublicRegistry(url) {
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * The registry settings of a .yarnrc.yml: the default server and the server
 * of each scope under `npmScopes`. Reads only what Yarn itself writes: top
 * level keys, and two-space nesting under `npmScopes`.
 */
function registryConfig(yarnrc, env) {
  const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const config = { server: env.YARN_NPM_REGISTRY_SERVER || undefined, scopes: new Map() };
  let inScopes = false;
  let scope;
  for (const line of yarnrc.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inScopes = /^npmScopes:\s*$/.test(line);
      const server = line.match(/^npmRegistryServer:\s*(.+)$/);
      if (server && !config.server) config.server = unquote(server[1]);
      continue;
    }
    if (!inScopes) continue;
    const name = line.match(/^ {2}(\S.*):\s*$/);
    if (name) {
      scope = unquote(name[1]).replace(/^@/, "");
      config.scopes.set(scope, undefined);
      continue;
    }
    const server = line.match(/^ {4}npmRegistryServer:\s*(.+)$/);
    if (server && scope !== undefined) config.scopes.set(scope, unquote(server[1]));
  }
  return config;
}

/**
 * Every name@version yarn.lock resolves through the npm protocol, and the
 * packages that cannot be checked against the public registry. The lockfile
 * records no registry, so that comes from the .yarnrc.yml settings.
 */
function lockedPackages(lockfile, config) {
  const packages = new Map();
  const notChecked = new Map();
  for (const line of lockfile.split(/\r?\n/)) {
    const match = line.match(/^ {2}resolution: "(.+)"$/);
    if (!match) continue;
    const resolution = match[1];
    // A workspace is ours. A patch is checked through the package it patches.
    if (/@(workspace|patch):/.test(resolution)) continue;
    // name@npm:1.2.3, optionally followed by ::__archiveUrl=<encoded url>.
    const npm = resolution.match(/^((?:@[^/@]+\/)?[^/@]+)@npm:([^:@]+)(?:::(.*))?$/);
    if (!npm) {
      notChecked.set(resolution, "not from an npm registry");
      continue;
    }
    const [, name, version, parameters] = npm;
    const id = name + "@" + version;
    const scope = name.startsWith("@") ? name.slice(1, name.indexOf("/")) : undefined;
    const server =
      (scope !== undefined && config.scopes.get(scope)) || config.server || REGISTRY;
    const archive = new URLSearchParams(parameters || "").get("__archiveUrl");
    if (!isPublicRegistry(server)) {
      notChecked.set(id, "from " + server);
    } else if (archive && !isPublicRegistry(archive)) {
      notChecked.set(id, "tarball from " + archive);
    } else {
      packages.set(id, { name, version });
    }
  }
  return {
    packages: [...packages.values()],
    notChecked: [...notChecked].map(([id, reason]) => ({ id, reason })),
  };
}

/** Names the workspaces depend on directly. */
function directDependencies() {
  const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const files = ["package.json"];
  const workspaces = root.workspaces || [];
  for (const glob of Array.isArray(workspaces) ? workspaces : workspaces.packages || []) {
    if (!glob.endsWith("/*")) {
      files.push(path.join(glob, "package.json"));
      continue;
    }
    const dir = glob.slice(0, -2);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(path.join(dir, entry.name, "package.json"));
    }
  }
  const names = new Set();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(pkg[section] || {})) names.add(name);
    }
  }
  return names;
}

/** `git+https://github.com/Owner/Repo.git@refs/tags/1.0.0` -> `https://github.com/owner/repo`. */
function normalizeRepository(uri) {
  if (typeof uri !== "string" || uri === "") return undefined;
  return uri
    .replace(/^git\+/, "")
    .replace(/@[^@/]*refs\/.*$/, "")
    .replace(/@[0-9a-f]{40}$/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** The source repository a SLSA provenance statement names (v1 and v0.2). */
function sourceRepository(statement) {
  const predicate = statement.predicate || {};
  const definition = predicate.buildDefinition || {};
  const workflow = (definition.externalParameters || {}).workflow || {};
  const resolved = (definition.resolvedDependencies || [])[0] || {};
  const configSource = (predicate.invocation || {}).configSource || {};
  return (
    normalizeRepository(workflow.repository) ||
    normalizeRepository(resolved.uri) ||
    normalizeRepository(configSource.uri)
  );
}

/**
 * The source repository in the signing certificate of a Sigstore bundle.
 * Fulcio writes it from the build's OIDC token, so unlike the statement it is
 * not the signer's to choose.
 */
function certificateRepository(bundle, X509Certificate) {
  const material = bundle.verificationMaterial || {};
  const chain = (material.x509CertificateChain || {}).certificates || [];
  const raw = (material.certificate || chain[0] || {}).rawBytes;
  if (!raw) return undefined;
  const extension = X509Certificate.parse(Buffer.from(raw, "base64")).extension(
    OID_SOURCE_REPOSITORY,
  );
  // The extension value is a DER UTF8String (tag 0x0c) inside the octet string.
  const value = extension && extension.valueObj.subs[0];
  if (!value || value.tag.number !== 0x0c) return undefined;
  return normalizeRepository(value.value.toString("utf8"));
}

/** As npm's `audit signatures`: keys from the Sigstore TUF repository, else the registry. */
async function registryKeys(npm, options) {
  const client = await npm.tuf.initTUF({
    cachePath: options.tufCache,
    retry: options.retry,
    timeout: options.timeout,
  });
  const { host, pathname } = new URL(REGISTRY);
  const target = host + pathname.replace(/\/$/, "") + "/keys.json";
  try {
    const { keys } = JSON.parse(await client.getTarget(target));
    return keys.map((key) => ({
      ...key,
      keyid: key.keyId,
      pemkey:
        "-----BEGIN PUBLIC KEY-----\n" + key.publicKey.rawBytes + "\n-----END PUBLIC KEY-----",
      expires: key.publicKey.validFor.end || null,
    }));
  } catch (error) {
    if (error.code !== "TUF_FIND_TARGET_ERROR") throw error;
  }
  const { keys } = await npm.fetch.json("/-/npm/v1/keys", options);
  return keys.map((key) => ({
    ...key,
    pemkey: "-----BEGIN PUBLIC KEY-----\n" + key.key + "\n-----END PUBLIC KEY-----",
  }));
}

/**
 * Verifies one package. Returns `{ repository }` when it has verified
 * provenance, `{}` when it has none, or `{ invalid }`.
 */
async function verifyPackage(npm, options, { name, version }) {
  let manifest;
  try {
    manifest = await npm.pacote.manifest(name + "@" + version, {
      ...options,
      verifySignatures: true,
      verifyAttestations: true,
    });
  } catch (error) {
    if (INVALID_CODES.has(error.code)) return { invalid: error.message };
    if (error.code === "E404" || error.code === "ETARGET") {
      return { invalid: name + "@" + version + " is not on " + REGISTRY };
    }
    throw error;
  }
  if (!(manifest._signatures || []).length) {
    return { invalid: name + "@" + version + " has no registry signature" };
  }
  if (!manifest._attestations) return {};

  // pacote verified every attestation but does not hand them back. Read the
  // provenance once more, and verify what was read before believing it.
  const { attestations } = await npm.fetch.json(
    new URL(manifest._attestations.url).pathname,
    options,
  );
  const provenance = attestations.find(({ predicateType }) =>
    String(predicateType).startsWith(PROVENANCE_PREFIX),
  );
  if (!provenance) return {};
  try {
    await npm.sigstore.verify(provenance.bundle, {
      tufCachePath: options.tufCache,
      tufForceCache: true,
    });
  } catch (error) {
    return { invalid: name + "@" + version + " failed to verify provenance: " + error.message };
  }
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
  );
  const signedDigest = ((statement.subject || [])[0] || { digest: {} }).digest.sha512;
  const tarballDigest = Buffer.from(
    String(manifest._integrity).replace(/^sha512-/, ""),
    "base64",
  ).toString("hex");
  if (signedDigest !== tarballDigest) {
    return { invalid: name + "@" + version + " provenance is for another tarball" };
  }
  // Trust the repository in the verified certificate, not the statement,
  // whose text the signer writes.
  let repository;
  try {
    repository = certificateRepository(provenance.bundle, npm.X509Certificate);
  } catch (error) {
    return { invalid: name + "@" + version + " has an unreadable signing certificate: " + error.message };
  }
  if (!repository) {
    return { invalid: name + "@" + version + " signing certificate names no source repository" };
  }
  const stated = sourceRepository(statement);
  if (stated && stated !== repository) {
    return {
      invalid:
        name + "@" + version + " provenance says " + stated +
        " but was signed by a build of " + repository,
    };
  }
  return { repository };
}

async function verifyAll(npm, options, packages) {
  const results = new Array(packages.length);
  let next = 0;
  async function worker() {
    while (next < packages.length) {
      const position = next;
      next += 1;
      results[position] = { ...packages[position], ...(await verifyPackage(npm, options, packages[position])) };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

/**
 * Compares the verified results with the baseline. Pure.
 * Baseline: { [name]: { repository, since } }, `since` being the lowest
 * version seen with provenance.
 */
// Hand-written fields of a baseline entry, never written by `update`:
//   formerRepositories        other source repositories accepted for this
//                             package (a repository that moved, while builds
//                             from both are locked)
//   versionsWithoutProvenance exact versions accepted without provenance
const listed = (value) => (Array.isArray(value) ? value : []);

function judge(results, baseline, semver) {
  const failures = [];
  const additions = {};
  const next = JSON.parse(JSON.stringify(baseline));

  for (const result of results) {
    const id = result.name + "@" + result.version;
    if (result.invalid) {
      failures.push("Invalid: " + result.invalid);
      continue;
    }
    const known = baseline[result.name];

    if (!result.repository) {
      if (
        known && semver.gte(result.version, known.since) &&
        !listed(known.versionsWithoutProvenance).includes(result.version)
      ) {
        failures.push(
          "Provenance dropped: " + id + " has none, but " + result.name + " has had it since " +
            known.since + " (" + known.repository + ")",
        );
      }
      continue;
    }
    if (
      known && known.repository !== result.repository &&
      !listed(known.formerRepositories).includes(result.repository)
    ) {
      failures.push(
        "Source repository changed: " + id + " was built from " + result.repository +
          ", the baseline says " + known.repository,
      );
      continue;
    }
    const entry = next[result.name];
    if (!entry) {
      next[result.name] = { repository: result.repository, since: result.version };
      additions[result.name] = true;
    } else if (semver.lt(result.version, entry.since)) {
      entry.since = result.version;
      additions[result.name] = true;
    }
  }

  const sorted = {};
  for (const name of Object.keys(next).sort()) sorted[name] = next[name];
  const added = Object.keys(additions).sort();
  // Entries recorded in this run are held to the same rules in this run, so
  // two locked versions of a new package that disagree fail now, not on the
  // next run. The second pass adds nothing: every entry exists at its lowest
  // version.
  if (added.length) {
    for (const failure of judge(results, sorted, semver).failures) {
      if (!failures.includes(failure)) failures.push(failure);
    }
  }
  return { failures, additions: added, next: sorted };
}

// The baseline as it is written: two-space JSON, with the hand-written lists
// on one line, which is how a formatter (Biome) prints a short list. `update`
// rewrites the whole file, so it must not undo that.
function serialize(baseline) {
  return (
    JSON.stringify(baseline, null, 2).replace(
      /\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g,
      (_match, items) => "[" + items.replace(/,\n\s+/g, ", ") + "]",
    ) + "\n"
  );
}

async function main() {
  const npm = loadNpm();
  const options = {
    registry: REGISTRY,
    tufCache: path.join(workDir, "tuf"),
    retry: { retries: 2, factor: 10, minTimeout: 10000, maxTimeout: 60000 },
    timeout: 300000,
  };
  const yarnrc = fs.existsSync(".yarnrc.yml") ? fs.readFileSync(".yarnrc.yml", "utf8") : "";
  const { packages, notChecked } = lockedPackages(
    fs.readFileSync("yarn.lock", "utf8"),
    registryConfig(yarnrc, process.env),
  );
  if (!packages.length) throw new Error("yarn.lock has no package from the npm registry");
  console.log(
    "Verifying " + packages.length + " packages with npm " + npm.version +
      " (Node " + process.versions.node + ")",
  );

  const keys = await registryKeys(npm, options);
  if (!keys.length) throw new Error("The registry returned no signing keys");
  const { host, pathname } = new URL(REGISTRY);
  options["//" + host + pathname + ":_keys"] = keys;

  const results = await verifyAll(npm, options, packages);
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};
  const { failures, additions, next } = judge(results, baseline, npm.semver);

  const withProvenance = results.filter((result) => result.repository);
  const invalid = results.filter((result) => result.invalid);
  const direct = directDependencies();
  const directWithout = results
    .filter((r) => !r.repository && !r.invalid && direct.has(r.name))
    .map((r) => r.name + "@" + r.version)
    .sort();

  console.log("Registry signatures verified: " + (results.length - invalid.length));
  console.log("Provenance verified: " + withProvenance.length);
  console.log("No provenance published: " + (results.length - withProvenance.length - invalid.length));
  if (directWithout.length) {
    console.log("Direct dependencies without provenance:");
    for (const id of directWithout) console.log("  " + id);
  }
  if (notChecked.length) {
    console.log("Not checked:");
    for (const { id, reason } of notChecked) console.log("  " + id + " (" + reason + ")");
  }

  // `update` records new entries even when something fails, so there is a
  // file to edit by hand. It only adds entries and lowers `since`: it accepts
  // nothing that fails.
  if (additions.length && mode === "update") {
    fs.writeFileSync(BASELINE, serialize(next));
    console.log("Recorded " + additions.length + " package(s) in " + BASELINE + ". Review the diff and commit it.");
  }

  if (failures.length) {
    for (const failure of failures.sort()) console.error("Error: " + failure);
    console.error(
      "If a change is intended, review it and edit " + BASELINE + " by hand (formerRepositories, " +
        "versionsWithoutProvenance: see docs/security-scripts.md in TowoLabs/base-repository). " +
        "`update` never changes or removes an entry.",
    );
    return 1;
  }

  if (additions.length && mode !== "update") {
    console.error("Error: " + BASELINE + " is out of date for:");
    for (const name of additions) console.error("  " + name + " (" + next[name].repository + ", since " + next[name].since + ")");
    console.error("Run ./yarn security:verify-attestations:update, review the diff and commit it.");
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error("Error: could not complete the verification: " + (error.message || error));
      if (error.code) console.error("  code: " + error.code);
      process.exitCode = 2;
    },
  );
} else {
  module.exports = {
    certificateRepository,
    judge,
    loadNpm,
    lockedPackages,
    normalizeRepository,
    registryConfig,
    serialize,
    sourceRepository,
  };
}
EOF

set +e
node "$WORK_DIR/verify.cjs" "$MODE" "$WORK_DIR" >"$WORK_DIR/output" 2>&1
STATUS=$?
set -e

if [ "$STATUS" -ne 0 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%b\n' "${RED}${line}${NC}"
  done <"$WORK_DIR/output"
  if [ "$STATUS" -eq 2 ]; then
    printf '%b\n' "${YELLOW}This check needs network access to registry.npmjs.org and tuf-repo-cdn.sigstore.dev.${NC}"
  fi
  exit "$STATUS"
fi

cat "$WORK_DIR/output"
printf '%b\n' "${GREEN}Registry signatures and build attestations are valid and match package-attestations.json${NC}"

exit 0
