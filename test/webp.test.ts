import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { isWebpMagic, readWebpDimensions } from "../src/webp.js";

describe("webp helpers", () => {
  test("isWebpMagic rejects non-WebP", () => {
    assert.equal(isWebpMagic(Buffer.from("not-webp")), false);
  });

  test("readWebpDimensions parses cwebp output", () => {
    const which = spawnSync("which", ["cwebp"], { encoding: "utf8" });
    if (which.status !== 0) {
      // Optional OS tool — skip when libwebp is not installed (CI may still have it).
      return;
    }

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webp-test-"));
    const pngPath = path.join(dir, "1.png");
    const webpPath = path.join(dir, "1.webp");
    fs.writeFileSync(pngPath, png);
    const result = spawnSync("cwebp", ["-q", "80", "-quiet", pngPath, "-o", webpPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const bytes = fs.readFileSync(webpPath);
    assert.equal(isWebpMagic(bytes), true);
    const dims = readWebpDimensions(bytes);
    assert.ok(dims);
    assert.equal(dims.width, 1);
    assert.equal(dims.height, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
