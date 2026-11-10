import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertGithubAssetBasePinsReleaseTag,
  assertJsDelivrReleaseBase,
  jsDelivrDataBase,
  releaseTagForVersion,
} from "../src/releaseTag.js";

describe("releaseTagForVersion", () => {
  test("uses the package version as the tag", () => {
    assert.equal(releaseTagForVersion("1.0.0"), "1.0.0");
    assert.equal(releaseTagForVersion("1.2.3"), "1.2.3");
    assert.equal(releaseTagForVersion("1.2.3-rc.1"), "1.2.3-rc.1");
    assertGithubAssetBasePinsReleaseTag(
      "https://raw.githubusercontent.com/bifrostwallet/assets/1.0.0/data/",
      "1.0.0",
    );
    assertGithubAssetBasePinsReleaseTag(
      "https://raw.githubusercontent.com/bifrostwallet/assets/1.2.3/data/",
      "1.2.3",
    );
    assert.throws(
      () =>
        assertGithubAssetBasePinsReleaseTag(
          "https://raw.githubusercontent.com/bifrostwallet/assets/1.2.3/data/",
          "1.0.0",
        ),
      /exactly one \/1\.0\.0\//,
    );
    assert.throws(
      () =>
        assertGithubAssetBasePinsReleaseTag(
          "https://raw.githubusercontent.com/bifrostwallet/assets/main/data/",
          "1.0.0",
        ),
      /exactly one \/1\.0\.0\//,
    );
  });

  test("rejects a version that is not semver", () => {
    assert.throws(() => releaseTagForVersion("1.2"), /not valid semver/);
    assert.throws(() => releaseTagForVersion("01.2.3"), /not valid semver/);
  });

  test("pins the jsDelivr release base once", () => {
    assert.equal(
      jsDelivrDataBase("bifrostwallet", "assets", "1.2.3"),
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.2.3/data/",
    );
    assert.equal(
      jsDelivrDataBase("bifrostwallet", "assets", releaseTagForVersion("1.0.0")),
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.0.0/data/",
    );
    assertJsDelivrReleaseBase(
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.0.0/data/",
      "1.0.0",
    );
    assertJsDelivrReleaseBase(
      "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.2.3/data/",
      "1.2.3",
    );
    assert.throws(
      () =>
        assertJsDelivrReleaseBase(
          "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@1.2.3/data/",
          "1.0.0",
        ),
      /must pin @1\.0\.0/,
    );
    assert.throws(
      () =>
        assertJsDelivrReleaseBase(
          "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/",
          "1.0.0",
        ),
      /must pin @1\.0\.0/,
    );
  });
});
