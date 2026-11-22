#!/bin/sh

# Offline tests of the rules in verify-attestations.sh: lockfile and
# .yarnrc.yml reading, the repository in a signing certificate, repository
# normalization and the baseline comparison. POSIX sh. No network: the
# signature verification itself is npm's code and is exercised by the
# Attestations workflow.
#
# The Node program embedded in verify-attestations.sh is extracted and
# required, so the rules tested are the rules that run.

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

GATE=scripts/security/verify-attestations.sh
FIXTURES="$ROOT/scripts/security/fixtures/attestations"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Everything between the heredoc opener and its closing EOF.
awk '
  /^EOF$/ { inside = 0 }
  inside { print }
  /^cat >"\$WORK_DIR\/verify.cjs" <<.EOF.$/ { inside = 1 }
' "$GATE" >"$WORK_DIR/verify.cjs"

if [ ! -s "$WORK_DIR/verify.cjs" ]; then
  printf '%b\n' "${RED}Error: could not extract the embedded program from ${GATE}.${NC}" >&2
  exit 1
fi

cat >"$WORK_DIR/test.cjs" <<'EOF'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const [programPath, fixtures] = process.argv.slice(2);
const gate = require(programPath);
const { semver, X509Certificate } = gate.loadNpm();

const REPO = "https://github.com/example-org/example-repo";
const OTHER = "https://github.com/someone-else/example-repo";
const judge = (results, baseline) => gate.judge(results, baseline, semver);
const known = { a: { repository: REPO, since: "2.0.0" } };
let count = 0;

function test(name, run) {
  try {
    run();
    count += 1;
  } catch (error) {
    console.error("FAILED: " + name);
    throw error;
  }
}

// --- Baseline rules -------------------------------------------------------

test("a new package with provenance is an addition, not a failure", () => {
  const { failures, additions, next } = judge([{ name: "a", version: "2.0.0", repository: REPO }], {});
  assert.deepEqual(failures, []);
  assert.deepEqual(additions, ["a"]);
  assert.deepEqual(next, known);
});

test("a later version from the same repository changes nothing", () => {
  const { failures, additions } = judge([{ name: "a", version: "2.1.0", repository: REPO }], known);
  assert.deepEqual([failures, additions], [[], []]);
});

test("provenance dropped above `since` fails", () => {
  const { failures } = judge([{ name: "a", version: "2.1.0" }], known);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Provenance dropped: a@2\.1\.0/);
});

test("provenance dropped at exactly `since` fails", () => {
  const { failures } = judge([{ name: "a", version: "2.0.0" }], known);
  assert.match(failures[0], /^Provenance dropped: a@2\.0\.0/);
});

test("a version below `since` without provenance passes", () => {
  const { failures, additions } = judge(
    [{ name: "a", version: "1.9.9" }, { name: "a", version: "2.0.0", repository: REPO }],
    known,
  );
  assert.deepEqual([failures, additions], [[], []]);
});

test("a prerelease of `since` is below it", () => {
  assert.deepEqual(judge([{ name: "a", version: "2.0.0-beta.1" }], known).failures, []);
});

test("another source repository fails and is not recorded", () => {
  const { failures, additions, next } = judge([{ name: "a", version: "2.1.0", repository: OTHER }], known);
  assert.match(failures[0], /^Source repository changed: a@2\.1\.0/);
  assert.deepEqual(additions, []);
  assert.deepEqual(next, known);
});

test("a lower version with provenance lowers `since`", () => {
  const { failures, additions, next } = judge([{ name: "a", version: "1.5.0", repository: REPO }], known);
  assert.deepEqual(failures, []);
  assert.deepEqual(additions, ["a"]);
  assert.equal(next.a.since, "1.5.0");
});

test("an invalid package fails whatever the baseline says", () => {
  const { failures } = judge([{ name: "a", version: "2.1.0", invalid: "a@2.1.0 is broken" }], known);
  assert.deepEqual(failures, ["Invalid: a@2.1.0 is broken"]);
});

test("entries of packages no longer locked are kept, and output is sorted", () => {
  const { next, failures } = judge([{ name: "0", version: "1.0.0", repository: REPO }], known);
  assert.deepEqual(failures, []);
  assert.deepEqual(Object.keys(next), ["0", "a"]);
});

test("a package without provenance that is not in the baseline passes", () => {
  assert.deepEqual(judge([{ name: "b", version: "1.0.0" }], known).failures, []);
});

test("two locked versions of a new package from different repositories fail in the same run", () => {
  const { failures, additions } = judge(
    [{ name: "a", version: "2.0.0", repository: REPO }, { name: "a", version: "2.1.0", repository: OTHER }],
    {},
  );
  assert.deepEqual(additions, ["a"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Source repository changed: a@2\.1\.0/);
});

test("a new package whose higher locked version has no provenance fails in the same run", () => {
  const { failures } = judge(
    [{ name: "a", version: "2.0.0", repository: REPO }, { name: "a", version: "2.1.0" }],
    {},
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^Provenance dropped: a@2\.1\.0/);
});

test("a former repository written by hand is accepted, another one is not", () => {
  const moved = { a: { repository: OTHER, since: "2.0.0", formerRepositories: [REPO] } };
  const both = [{ name: "a", version: "2.0.0", repository: REPO }, { name: "a", version: "2.1.0", repository: OTHER }];
  assert.deepEqual(judge(both, moved).failures, []);
  const third = judge([{ name: "a", version: "2.2.0", repository: "https://github.com/third/example-repo" }], moved);
  assert.match(third.failures[0], /^Source repository changed: a@2\.2\.0/);
});

test("a version listed by hand may have no provenance, the next one may not", () => {
  const excused = { a: { repository: REPO, since: "2.0.0", versionsWithoutProvenance: ["2.1.0"] } };
  assert.deepEqual(judge([{ name: "a", version: "2.1.0" }], excused).failures, []);
  assert.match(judge([{ name: "a", version: "2.1.1" }], excused).failures[0], /^Provenance dropped: a@2\.1\.1/);
});

test("hand-written fields survive an update that lowers `since`", () => {
  const moved = { a: { repository: OTHER, since: "2.0.0", formerRepositories: [REPO], versionsWithoutProvenance: ["2.1.0"] } };
  const { next, failures } = judge([{ name: "a", version: "1.5.0", repository: REPO }], moved);
  assert.deepEqual(failures, []);
  assert.deepEqual(next.a, { ...moved.a, since: "1.5.0" });
});

test("the baseline is written with hand-written lists on one line", () => {
  const baseline = {
    a: { repository: OTHER, since: "2.0.0", formerRepositories: [REPO], versionsWithoutProvenance: ["2.1.0", "2.2.0"] },
    b: { repository: REPO, since: "1.0.0" },
  };
  const text = gate.serialize(baseline);
  assert.deepEqual(JSON.parse(text), baseline);
  assert.ok(text.includes('    "formerRepositories": ["' + REPO + '"],\n'));
  assert.ok(text.includes('    "versionsWithoutProvenance": ["2.1.0", "2.2.0"]\n'));
  assert.equal(gate.serialize({ b: baseline.b }), JSON.stringify({ b: baseline.b }, null, 2) + "\n");
});

// --- Repository names -----------------------------------------------------

test("repository normalization", () => {
  const cases = {
    "https://github.com/Example-Org/Example-Repo": REPO,
    "https://github.com/example-org/example-repo.git": REPO,
    "https://github.com/example-org/example-repo/": REPO,
    "git+https://github.com/example-org/example-repo@refs/tags/1.0.0": REPO,
    "git+https://github.com/example-org/example-repo@refs/heads/main": REPO,
    "git+https://github.com/example-org/example-repo@0123456789abcdef0123456789abcdef01234567": REPO,
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(gate.normalizeRepository(input), expected, input);
  }
  assert.equal(gate.normalizeRepository(""), undefined);
  assert.equal(gate.normalizeRepository(undefined), undefined);
});

test("the repository a statement names: SLSA v1, its fallback, and v0.2", () => {
  const v1 = { predicate: { buildDefinition: { externalParameters: { workflow: { repository: "https://github.com/Example-Org/Example-Repo" } } } } };
  const v1Resolved = { predicate: { buildDefinition: { resolvedDependencies: [{ uri: "git+https://github.com/example-org/example-repo@refs/tags/1.0.0" }] } } };
  const v02 = { predicate: { invocation: { configSource: { uri: "git+https://github.com/example-org/example-repo@refs/heads/main" } } } };
  for (const statement of [v1, v1Resolved, v02]) assert.equal(gate.sourceRepository(statement), REPO);
  assert.equal(gate.sourceRepository({ predicate: {} }), undefined);
  assert.equal(gate.sourceRepository({}), undefined);
});

// --- Signing certificate --------------------------------------------------

function rawBytes(file) {
  const pem = fs.readFileSync(path.join(fixtures, file), "utf8");
  return pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
}

test("the repository comes from the certificate's Source Repository URI", () => {
  const raw = rawBytes("certificate-with-source-repository.pem");
  const single = { verificationMaterial: { certificate: { rawBytes: raw } } };
  const chain = { verificationMaterial: { x509CertificateChain: { certificates: [{ rawBytes: raw }] } } };
  assert.equal(gate.certificateRepository(single, X509Certificate), REPO);
  assert.equal(gate.certificateRepository(chain, X509Certificate), REPO);
});

test("a certificate without the extension, or no certificate, names no repository", () => {
  const raw = rawBytes("certificate-without-source-repository.pem");
  assert.equal(gate.certificateRepository({ verificationMaterial: { certificate: { rawBytes: raw } } }, X509Certificate), undefined);
  assert.equal(gate.certificateRepository({ verificationMaterial: {} }, X509Certificate), undefined);
  assert.equal(gate.certificateRepository({}, X509Certificate), undefined);
});

test("a certificate that does not parse throws", () => {
  const bundle = { verificationMaterial: { certificate: { rawBytes: Buffer.from("not a certificate").toString("base64") } } };
  assert.throws(() => gate.certificateRepository(bundle, X509Certificate));
});

// --- Lockfile and .yarnrc.yml ---------------------------------------------

const LOCKFILE = [
  "__metadata:",
  "  version: 10",
  "",
  '"plain@npm:1.2.3":',
  "  version: 1.2.3",
  '  resolution: "plain@npm:1.2.3"',
  "",
  '"@scope/pkg@npm:2.0.0-beta.1":',
  '  resolution: "@scope/pkg@npm:2.0.0-beta.1"',
  "",
  '"alias@npm:real@3.0.0":',
  '  resolution: "real@npm:3.0.0"',
  "",
  '"plain@npm:1.0.0, plain@npm:^1.0.0":',
  '  resolution: "plain@npm:1.0.0"',
  "",
  '"twice@npm:1.0.0":',
  '  resolution: "twice@npm:1.0.0"',
  '"twice@npm:1.0.0#again":',
  '  resolution: "twice@npm:1.0.0"',
  "",
  '"mirrored@npm:4.0.0":',
  '  resolution: "mirrored@npm:4.0.0::__archiveUrl=https%3A%2F%2Fregistry.npmjs.org%2Fmirrored%2F-%2Fodd-name-4.0.0.tgz"',
  "",
  '"elsewhere@npm:5.0.0":',
  '  resolution: "elsewhere@npm:5.0.0::__archiveUrl=https%3A%2F%2Fnpm.pkg.github.com%2Fdownload%2Felsewhere%2F5.0.0%2Fabc"',
  "",
  '"@private/thing@npm:6.0.0":',
  '  resolution: "@private/thing@npm:6.0.0"',
  "",
  '"patched@patch:patched@npm%3A7.0.0#~builtin<compat/patched>":',
  '  resolution: "patched@patch:patched@npm%3A7.0.0#optional!builtin<compat/patched>::version=7.0.0&hash=abc123"',
  "",
  '"patched@npm:7.0.0":',
  '  resolution: "patched@npm:7.0.0"',
  "",
  '"root@workspace:.":',
  '  resolution: "root@workspace:."',
  "",
  '"fromgit@https://github.com/example-org/fromgit.git#commit=0123456789abcdef0123456789abcdef01234567":',
  '  resolution: "fromgit@https://github.com/example-org/fromgit.git#commit=0123456789abcdef0123456789abcdef01234567"',
  "",
].join("\n");

const ids = (packages) => packages.map(({ name, version }) => name + "@" + version).sort();
const noConfig = gate.registryConfig("", {});

test("npm resolutions are read once each, with aliases, suffixes and patches handled", () => {
  const { packages, notChecked } = gate.lockedPackages(LOCKFILE, noConfig);
  assert.deepEqual(ids(packages), [
    "@private/thing@6.0.0",
    "@scope/pkg@2.0.0-beta.1",
    "mirrored@4.0.0",
    "patched@7.0.0",
    "plain@1.0.0",
    "plain@1.2.3",
    "real@3.0.0",
    "twice@1.0.0",
  ]);
  assert.deepEqual(
    notChecked.map(({ id }) => id).sort(),
    [
      "elsewhere@5.0.0",
      "fromgit@https://github.com/example-org/fromgit.git#commit=0123456789abcdef0123456789abcdef01234567",
    ],
  );
});

test("a scope with its own registry is not looked up on the public registry", () => {
  const yarnrc = [
    "enableScripts: false",
    "npmScopes:",
    "  private:",
    '    npmRegistryServer: "https://npm.pkg.github.com"',
    "    npmAlwaysAuth: true",
    '  "@scope":',
    "    npmAlwaysAuth: false",
    "nodeLinker: pnp",
  ].join("\n");
  const config = gate.registryConfig(yarnrc, {});
  assert.equal(config.scopes.get("private"), "https://npm.pkg.github.com");
  assert.equal(config.scopes.has("scope"), true);
  const { packages, notChecked } = gate.lockedPackages(LOCKFILE, config);
  assert.equal(ids(packages).includes("@private/thing@6.0.0"), false);
  assert.equal(ids(packages).includes("@scope/pkg@2.0.0-beta.1"), true);
  assert.deepEqual(notChecked.find(({ id }) => id === "@private/thing@6.0.0"), {
    id: "@private/thing@6.0.0",
    reason: "from https://npm.pkg.github.com",
  });
});

test("another default registry means nothing is looked up on the public one", () => {
  for (const config of [
    gate.registryConfig("npmRegistryServer: https://npm.example.com\n", {}),
    gate.registryConfig("", { YARN_NPM_REGISTRY_SERVER: "https://npm.example.com" }),
  ]) {
    const { packages, notChecked } = gate.lockedPackages(LOCKFILE, config);
    assert.deepEqual(packages, []);
    assert.equal(notChecked.length, 10);
  }
});

test("Yarn's default server and a scope pointed back at npm count as public", () => {
  const yarnrc = [
    'npmRegistryServer: "https://registry.yarnpkg.com"',
    "npmScopes:",
    "  private:",
    "    npmRegistryServer: 'https://registry.npmjs.org'",
  ].join("\n");
  const { packages } = gate.lockedPackages(LOCKFILE, gate.registryConfig(yarnrc, {}));
  assert.equal(ids(packages).includes("@private/thing@6.0.0"), true);
  assert.equal(packages.length, 8);
});

test("this repository's own lockfile parses", () => {
  const { packages } = gate.lockedPackages(fs.readFileSync("yarn.lock", "utf8"), noConfig);
  assert.ok(packages.length > 0);
});

console.log(count + " attestation rule tests passed");
EOF

if ! node "$WORK_DIR/test.cjs" "$WORK_DIR/verify.cjs" "$FIXTURES"; then
  printf '%b\n' "${RED}Attestation gate rule tests failed${NC}" >&2
  exit 1
fi

printf '%b\n' "${GREEN}Attestation gate rules behave as specified${NC}"

exit 0
