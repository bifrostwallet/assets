import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  assertGithubAssetBasePinsReleaseTag,
  assertJsDelivrReleaseBase,
  jsDelivrDataBase,
  releaseTagForVersion,
} from "../src/releaseTag.js";

describe("releaseTagForVersion", () => {
  test("keeps a leading v on 0.x and drops it from 1.0.0", () => {
    assert.equal(releaseTagForVersion("0.0.6-beta"), "v0.0.6-beta");
    assert.equal(releaseTagForVersion("0.1.0-beta"), "v0.1.0-beta");
    assert.equal(releaseTagForVersion("1.0.0"), "1.0.0");
    assert.equal(releaseTagForVersion("1.2.3"), "1.2.3");
    assert.equal(releaseTagForVersion("1.2.3-rc.1"), "1.2.3-rc.1");
    assertGithubAssetBasePinsReleaseTag(
      "https://raw.githubusercontent.com/bifrostwallet/assets/v0.0.6-beta/data/",
      "0.0.6-beta",
    );
    assertGithubAssetBasePinsReleaseTag(
      "https://raw.githubusercontent.com/bifrostwallet/assets/1.0.0/data/",
      "1.0.0",
    );
    assert.throws(
      () =>
        assertGithubAssetBasePinsReleaseTag(
          "https://raw.githubusercontent.com/bifrostwallet/assets/v1.0.0/data/",
          "1.0.0",
        ),
      /exactly one \/1\.0\.0\//,
    );
  });

  test("rejects a version that is not semver", () => {
    assert.throws(() => releaseTagForVersion("1.2"), /not valid semver/);
    assert.throws(() => releaseTagForVersion("01.2.3"), /not valid semver/);
    assert.throws(() => releaseTagForVersion("v0.0.6-beta"), /must not start with "v"/);
  });

  test("a v-prefixed version agrees with a suffix check and is rejected", () => {
    const version = "v0.0.6-beta";
    const doubled = `https://raw.githubusercontent.com/bifrostwallet/assets/v${version}/data/`;
    assert.equal(doubled.endsWith(`/v${version}/data/`), true);
    assert.equal(doubled.includes("/vv"), true);
    assert.throws(() => releaseTagForVersion(version), /must not start with "v"/);
    assert.throws(
      () => assertGithubAssetBasePinsReleaseTag(doubled, "0.0.6-beta"),
      /must not contain \/vv/,
    );
  });

  test("pins the jsDelivr release base once", () => {
    assert.equal(
      jsDelivrDataBase("bifrostwallet", "assets", "v0.1.0-beta"),
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@v0.1.0-beta/data/",
    );
    assert.equal(
      jsDelivrDataBase("bifrostwallet", "assets", releaseTagForVersion("1.0.0")),
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.0.0/data/",
    );
    assertJsDelivrReleaseBase(
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@v0.1.0-beta/data/",
      "0.1.0-beta",
    );
    assertJsDelivrReleaseBase(
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.0.0/data/",
      "1.0.0",
    );
    assert.throws(
      () =>
        assertJsDelivrReleaseBase(
          "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@v1.0.0/data/",
          "1.0.0",
        ),
      /must pin @1\.0\.0/,
    );
    assert.throws(
      () =>
        assertJsDelivrReleaseBase(
          "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@vv0.1.0-beta/data/",
          "0.1.0-beta",
        ),
      /doubled v/,
    );
    assert.throws(
      () =>
        assertJsDelivrReleaseBase(
          "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/",
          "0.1.0-beta",
        ),
      /must pin @v0\.1\.0-beta/,
    );
  });

  test("buildPackage fails when package.json version starts with v", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assets-release-tag-"));
    const version = "v0.0.6-beta";
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      `${JSON.stringify({
        version,
        repository: "https://github.com/bifrostwallet/assets.git",
      })}\n`,
    );
    const script = path.join(process.cwd(), "build", "src", "script", "packageBuild.js");
    const source = [
      "import { chdir } from 'node:process';",
      `import buildPackage from ${JSON.stringify(script)};`,
      "chdir(process.env.ASSETS_TEST_ROOT);",
      "buildPackage();",
    ].join(" ");
    const result = spawnSync(
      path.join(process.cwd(), "yarn"),
      ["node", "--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASSETS_TEST_ROOT: tmp },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /must not start with "v"/);
    assert.match(output, /v0\.0\.6-beta/);
    assert.equal(output.includes("vv0.0.6-beta"), false);
  });
});
