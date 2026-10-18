import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { isValidImage } from "./validate.js";
import { encodePngFileToWebp } from "./webp.js";

function isPngMagic(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/**
 * Convert a PNG logo to catalog WebP bytes (128×128, at most 24 KB).
 * Rejects a non-PNG, a failed cwebp run, or WebP that misses the logo rules.
 * Does not copy the PNG bytes onto logo.webp.
 */
export function convertDappLogoPng(pngPath: string): Buffer {
  if (!fs.existsSync(pngPath)) {
    throw new Error("Logo file does not exist");
  }
  const source = fs.readFileSync(pngPath);
  if (!isPngMagic(source)) {
    throw new Error("Logo must be a PNG file");
  }

  let webp: Buffer;
  try {
    webp = encodePngFileToWebp(pngPath, {
      quality: 85,
      resize: {
        width: ASSET_LOGO_REQUIREMENTS.WIDTH,
        height: ASSET_LOGO_REQUIREMENTS.HEIGHT,
      },
    });
  } catch (error) {
    throw new Error(
      `Could not convert PNG to WebP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tmp = path.join(os.tmpdir(), `assets-dapp-logo-${process.pid}-${Date.now()}.webp`);
  try {
    fs.writeFileSync(tmp, webp);
    const logoValidation = isValidImage(tmp, {
      maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
      minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
      maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
      requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
    });
    if (!logoValidation.isValid) {
      throw new Error(`Logo validation failed: ${logoValidation.errors.join("; ")}`);
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }

  return webp;
}
