import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { convertLogoBytesToWebp } from "../src/tokenLogo.js";
import {
  encodeImageFileToWebp,
  isWebpMagic,
  readWebpDimensions,
  webpHasAlpha,
} from "../src/webp.js";

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

  test("transparent PNG stays transparent after catalog WebP encode", () => {
    const which = spawnSync("which", ["cwebp"], { encoding: "utf8" });
    if (which.status !== 0) return;

    // 8×8 PNG: clear corners, one semi-transparent pixel, an opaque center.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAKElEQVR4nGNgIAbckdNowCXHiKToP7KEyqMbjAwMDAxMhEynXAHlAABESAWq2M2SjAAAAABJRU5ErkJggg==",
      "base64",
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webp-alpha-"));
    const pngPath = path.join(dir, "alpha.png");
    fs.writeFileSync(pngPath, png);
    try {
      for (const quality of [85, 25]) {
        const encoded = encodeImageFileToWebp(pngPath, {
          quality,
          resize: { width: 128, height: 128 },
        });
        assert.equal(webpHasAlpha(encoded), true, `quality ${quality} dropped alpha`);
        const dims = readWebpDimensions(encoded);
        assert.equal(dims?.width, 128);
        assert.equal(dims?.height, 128);
      }

      const catalog = convertLogoBytesToWebp(png);
      assert.equal(webpHasAlpha(catalog), true);
      const dims = readWebpDimensions(catalog);
      assert.equal(dims?.width, 128);
      assert.equal(dims?.height, 128);
      assert.ok(catalog.length / 1024 <= 24);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
