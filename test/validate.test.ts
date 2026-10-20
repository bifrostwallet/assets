import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, mock, test } from "node:test";
import {
  isValidDescription,
  isValidEvmAddress,
  isValidImage,
  isValidName,
  isValidNodeID,
  isValidPublicKey,
  isValidURL,
} from "../src/validate.js";

describe("validate.ts tests", () => {
  test("isValidEvmAddress() behaves as expected", () => {
    const validEvmAddresses = [
      "0x486ac9352f2001d1f43b9c02622aa26099b86609", // All lowercase
      "0x486AC9352F2001D1F43B9C02622AA26099B86609", // All uppercase
      "0x486aC9352F2001d1f43B9c02622Aa26099b86609", // Valid checksum
    ];

    const invalidEvmAddresses = [
      "0x486ac9352f2001d1f43b9c02622aa260", // Too short
      "0x486ac9352f2001d1f43b9c02622aa26099b866099", // Too long
      "0X486AC9352F2001D1F43B9C02622AA26099B86609", // Uppercase 0x prefix
      "0x486ac9352f2001d1f43b9c02622aa26099b8660z", // Non-hex characters
      "0x486aC9352f2001D1F43b9C02622Aa26099b86609", // Invalid checksum
    ];

    for (const address of validEvmAddresses) {
      assert.equal(isValidEvmAddress(address), true);
    }

    for (const address of invalidEvmAddresses) {
      assert.equal(isValidEvmAddress(address), false);
    }
  });

  test("isValidUrl() behaves as expected for website URLs", () => {
    const validWebsiteURLs = [
      "https://example.com",
      "https://example.com/",
      "https://example.com/path",
      "https://example.com/path/to/page/",
      "https://sub.example.com",
      "https://example-site.com",
      "https://example.co.uk",
    ];

    for (const url of validWebsiteURLs) {
      assert.equal(isValidURL(url, "website"), true);
    }

    const invalidWebsiteURLs = [
      "sftp://example.com", // Wrong protocol 1
      "http://example.com", // Wrong protocol 2
      "https://example.com?param=value", // Query parameters
      "https://EXAMPLE.com", // Uppercase domain
      `https://${"a".repeat(120)}.com/logo.png`, // Too long
      "https://my-app.vercel.app",
      "https://service-xyz-uc.a.run.app",
      "https://bucket.s3.amazonaws.com",
      "https://cool-project.github.io",
      "https://x.com/someone",
    ];

    for (const url of invalidWebsiteURLs) {
      assert.equal(isValidURL(url, "website"), false);
    }
  });

  test("isValidName() behaves as expected", () => {
    const validNames = [
      "Example Name",
      "Example-Name",
      "Example.Name",
      "Example's Name",
      "Example+Name",
      "Example%Name",
      "Example/Name",
      "Éxàmplê Nàmé",
      "Example 123",
      "Example & Co.",
      "Example (Name)",
      "Example [Name]",
      "AB",
      `${"A".repeat(32)}`,
    ];

    for (const name of validNames) {
      assert.equal(isValidName(name), true, `Expected valid name: ${name}`);
    }

    const invalidNames = [
      "A",
      `${"A".repeat(33)}`,
      "Example\nName",
      "Example\tName",
      'Example"Name',
      "Example*Name",
      "Example<Name>",
      "Example|Name",
      "Example\\Name",
      "Example ",
      " Example",
    ];

    for (const name of invalidNames) {
      assert.equal(isValidName(name), false, `Expected invalid name: ${name}`);
    }
  });

  test("isValidDescription() behaves as expected", () => {
    const validDescriptions = [
      "This is a valid description for testing purposes.",
      "This description includes special characters: .'+-% and numbers 12345.",
      "This description has symbols: (test) [test] {test} ?!@_~;",
      `${"A".repeat(10)}`,
      `${"A".repeat(350)}`,
    ];

    for (const description of validDescriptions) {
      assert.equal(isValidDescription(description), true, `Expected valid: ${description}`);
    }

    // Descriptions are printable ASCII only (0x20–0x7E); reject length,
    // whitespace trim, control chars, and non-ASCII — not specific punctuation.
    const invalidDescriptions = [
      "This description has accented characters: Éxàmplê Nàmé.",
      "Too short",
      `${"A".repeat(351)}`,
      "Invalid\ncharacter",
      "Invalid\tcharacter",
      "Example description ",
      " Example description",
    ];

    for (const description of invalidDescriptions) {
      assert.equal(isValidDescription(description), false, `Expected invalid: ${description}`);
    }
  });

  test("isValidPublicKey() behaves as expected", () => {
    const validPublicKeys = [
      `0x${"a".repeat(128)}`, // All lowercase
      `0x${"A".repeat(128)}`, // All uppercase
      `0x${"0".repeat(128)}`, // All zeros
      `0x${"f".repeat(128)}`, // All f's
      `0x${"1".repeat(64)}${"a".repeat(64)}`, // Mixed numbers and letters
      `0x${"abcdef0123456789".repeat(8)}`, // Mixed hex characters
    ];

    const invalidPublicKeys = [
      `0x${"a".repeat(127)}`, // Too short
      `0x${"a".repeat(129)}`, // Too long
      `0X${"a".repeat(128)}`, // Uppercase 0X prefix
      `0x${"a".repeat(127)}g`, // Non-hex character
      `0x${"a".repeat(127)}G`, // Non-hex character (uppercase G)
      `${"a".repeat(128)}`, // Missing 0x prefix
      `0x${"a".repeat(128)} `, // Extra whitespace
    ];

    for (const publicKey of validPublicKeys) {
      assert.equal(isValidPublicKey(publicKey), true);
    }

    for (const publicKey of invalidPublicKeys) {
      assert.equal(isValidPublicKey(publicKey), false);
    }
  });

  test("isValidNodeId() behaves as expected", () => {
    const validNodeIDs = [
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9",
      "NodeID-P4T4uKqveVxjZZXVdADHENdnCKnsCFvDE",
      "NodeID-5QFVCtJieViQm5gCtTn3mNBqvGunCGWn1",
      "NodeID-MFrZFVCXPv5iCn6M9K6XdwVTK7qVUME4U",
      "NodeID-NFBbbJ4qCmNaCzeW7sxErhvWqvEQMnYcN",
      "NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg",
    ];

    const invalidNodeIDs = [
      "NodeID-", // Missing characters after prefix
      "NotANodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4v", // Note a node ID
      "nodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9", // Lowercase 'n' in prefix
      "NodeID_k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9", // Underscore instead of hyphen
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK", // Too short (31 chars after prefix)
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9aB", // Too long (34 chars after prefix)
      "NodeID-k4QG8eJ9bYu717nbj8Ki8Vy$kK8g1VWK", // Invalid character '$'
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK+", // Invalid character '+'
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK0", // Invalid character '0'
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWKO", // Invalid character 'O'
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWKl", // Invalid character 'l'
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWKI", // Invalid character 'I'
      "k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9", // Missing prefix
      " NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9", // Leading whitespace
      "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9 ", // Trailing whitespace
    ];

    for (const nodeID of validNodeIDs) {
      assert.equal(isValidNodeID(nodeID), true, `Expected valid but failed: ${nodeID}`);
    }

    for (const nodeID of invalidNodeIDs) {
      assert.equal(isValidNodeID(nodeID), false, `Expected invalid but passed: ${nodeID}`);
    }
  });

  test("isValidImage() behaves as expected", () => {
    // Mock a valid PNG file with a more complete header
    const validPngBuffer = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR chunk length
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x00,
      0x80, // width: 128px (0x80 in hex)
      0x00,
      0x00,
      0x00,
      0x80, // height: 128px (0x80 in hex)
      0x08, // bit depth
      0x02, // color type RGB (opaque; still valid)
      0x00, // compression method
      0x00, // filter method
      0x00, // interlace method
      0x00,
      0x00,
      0x00,
      0x00, // CRC (not correct, but not checked in the test)
    ]);

    // Mock fs functions
    const mockExistsSync = mock.method(fs, "existsSync", (() => true) as typeof fs.existsSync);
    const mockStatSync = mock.method(
      fs,
      "statSync",
      (() => ({ size: 10 * 1024 }) as fs.Stats) as unknown as typeof fs.statSync,
    );
    const mockReadFileSync = mock.method(
      fs,
      "readFileSync",
      (() => validPngBuffer) as unknown as typeof fs.readFileSync,
    );

    try {
      // Test valid PNG
      const validResult = isValidImage("/path/to/valid.png");

      assert.equal(validResult.isValid, true, validResult.errors.join(", "));
      assert.equal(validResult.errors.length, 0);
      assert.notEqual(validResult.metadata, undefined);
      assert.equal(validResult.metadata?.width, 128);
      assert.equal(validResult.metadata?.height, 128);
      assert.equal(validResult.metadata?.sizeKB, 10);

      // Square RGBA (transparent background) is valid. Opaque logos stay valid above.
      const transparentPngBuffer = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        0x00,
        0x00,
        0x00,
        0x0d,
        0x49,
        0x48,
        0x44,
        0x52,
        0x00,
        0x00,
        0x00,
        0x80,
        0x00,
        0x00,
        0x00,
        0x80,
        0x08,
        0x06, // color type RGBA
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
      ]);
      mockReadFileSync.mock.mockImplementation(
        (() => transparentPngBuffer) as unknown as typeof fs.readFileSync,
      );
      const transparentPngResult = isValidImage("/path/to/transparent.png");
      assert.equal(transparentPngResult.isValid, true, transparentPngResult.errors.join(", "));
      assert.equal(transparentPngResult.metadata?.width, 128);
      assert.equal(transparentPngResult.metadata?.height, 128);

      // Test file doesn't exist
      mockExistsSync.mock.mockImplementation((() => false) as typeof fs.existsSync);
      const noFileResult = isValidImage("/path/to/nonexistent.png");
      assert.equal(noFileResult.isValid, false);
      assert.ok(noFileResult.errors.includes("File does not exist"));

      // Test file too large
      mockExistsSync.mock.mockImplementation((() => true) as typeof fs.existsSync);
      mockStatSync.mock.mockImplementation(
        (() => ({ size: 1000 * 1024 }) as fs.Stats) as unknown as typeof fs.statSync,
      );
      const tooLargeResult = isValidImage("/path/to/large.png");
      assert.equal(tooLargeResult.isValid, false);
      assert.ok(tooLargeResult.errors.some((err) => err.includes("exceeds maximum size")));

      // Test invalid PNG signature
      mockStatSync.mock.mockImplementation(
        (() => ({ size: 10 * 1024 }) as fs.Stats) as unknown as typeof fs.statSync,
      );
      mockReadFileSync.mock.mockImplementation((() =>
        Buffer.from([0x00, 0x01, 0x02, 0x03])) as unknown as typeof fs.readFileSync);
      const invalidPngResult = isValidImage("/path/to/invalid.png");
      assert.equal(invalidPngResult.isValid, false);
      assert.ok(invalidPngResult.errors.includes("Not a valid PNG or WebP file"));

      // Test non-square image
      const nonSquarePngBuffer = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        0x00,
        0x00,
        0x00,
        0x80, // width: 128px (0x80 in hex)
        0x00,
        0x00,
        0x00,
        0x64, // height: 100px (0x64 in hex)
        0x08, // bit depth
        0x06, // color type RGBA (still allowed for published logos)
        0x00, // compression method
        0x00, // filter method
        0x00, // interlace method
        0x00,
        0x00,
        0x00,
        0x00, // CRC (not correct, but not checked in the test)
      ]);
      mockReadFileSync.mock.mockImplementation(
        (() => nonSquarePngBuffer) as unknown as typeof fs.readFileSync,
      );
      const nonSquareResult = isValidImage("/path/to/nonsquare.png");
      assert.equal(nonSquareResult.isValid, false);
      assert.ok(nonSquareResult.errors.some((err) => err.includes("not square")));
    } finally {
      mockReadFileSync.mock.restore();
      mockStatSync.mock.restore();
      mockExistsSync.mock.restore();
    }
  });

  test("isValidImage() accepts transparent WebP and opaque WebP", () => {
    // 128×128 lossless WebP fixtures: fully transparent (alpha) and opaque white.
    const transparentWebp = Buffer.from("UklGRhQAAABXRUJQVlA4TAgAAAAvf8AfEIiICA==", "base64");
    const opaqueWebp = Buffer.from("UklGRhYAAABXRUJQVlA4TAoAAAAvf8AfAEX/I/of", "base64");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logo-alpha-"));
    try {
      const transparentPath = path.join(dir, "transparent.webp");
      const opaquePath = path.join(dir, "opaque.webp");
      fs.writeFileSync(transparentPath, transparentWebp);
      fs.writeFileSync(opaquePath, opaqueWebp);

      const transparentResult = isValidImage(transparentPath);
      assert.equal(transparentResult.isValid, true, transparentResult.errors.join(", "));
      assert.equal(transparentResult.metadata?.width, 128);
      assert.equal(transparentResult.metadata?.height, 128);

      const opaqueResult = isValidImage(opaquePath);
      assert.equal(opaqueResult.isValid, true, opaqueResult.errors.join(", "));
      assert.equal(opaqueResult.metadata?.width, 128);
      assert.equal(opaqueResult.metadata?.height, 128);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("isValidUrl() behaves as expected for link URLs", () => {
    const validLinkUrls = {
      x: ["https://x.com/username", "https://x.com/user123", "https://x.com/user_name"],
      linkedin: [
        "https://www.linkedin.com/in/username",
        "https://www.linkedin.com/in/user-name",
        "https://www.linkedin.com/company/company-name",
      ],
      reddit: [
        "https://www.reddit.com/user/username",
        "https://www.reddit.com/r/subreddit",
        "https://www.reddit.com/r/subreddit-name",
      ],
      youtube: [
        "https://www.youtube.com/@channelname",
        "https://www.youtube.com/@channel123",
        "https://www.youtube.com/c/channelname",
      ],
      discord: [
        "https://discord.gg/invite",
        "https://discord.gg/invite-code",
        "https://discord.gg/a1b2c3d4",
      ],
      telegram: ["https://t.me/username", "https://t.me/channel", "https://t.me/user123"],
      github: [
        "https://github.com/username",
        "https://github.com/user-name",
        "https://github.com/user123",
      ],
      tiktok: [
        "https://www.tiktok.com/@username",
        "https://www.tiktok.com/@user.name",
        "https://www.tiktok.com/@user_name",
      ],
    };

    const invalidLinkUrls = {
      x: [
        "https://x.com/", // Missing username
        "https://x.com/toolongusername12345", // Too long (>15 chars)
        "https://x.com/user%name", // % not allowed
        "http://x.com/username", // Wrong protocol
        "https://x.com/user name", // Spaces not allowed
      ],
      linkedin: [
        "https://linkedin.com/in/username", // Missing www
        "https://www.linkedin.com/profile/username", // Wrong path format
        "https://www.linkedin.com/", // Missing path
        "http://www.linkedin.com/in/username", // Wrong protocol
      ],
      reddit: [
        "https://www.reddit.com/username", // Missing user/ or r/ prefix
        "https://reddit.com/", // Missing path
        "http://reddit.com/user/username", // Wrong protocol
      ],
      youtube: [
        "https://youtube.com/@username", // Missing www
        "https://www.youtube.com/username", // Missing @ or c/ prefix
        "https://www.youtube.com/", // Missing username
        "http://www.youtube.com/@username", // Wrong protocol
      ],
      discord: [
        "https://discord.com/invite", // Wrong domain
        "https://discord.gg/", // Missing invite code
        "http://discord.gg/invite", // Wrong protocol
      ],
      telegram: [
        "https://telegram.org/username", // Wrong domain
        "https://t.me/", // Missing username
        "http://t.me/username", // Wrong protocol
        "https://t.me/us", // Too short (< 5 chars)
        "https://t.me/toolongusernametoolongusernametoolongusername", // Too long (> 32 chars)
      ],
      github: [
        "https://github.com/", // Missing username
        "http://github.com/username", // Wrong protocol
        "https://github.com/user name", // Spaces not allowed
      ],
      tiktok: [
        "https://tiktok.com/@username", // Missing www
        "https://www.tiktok.com/username", // Missing @ prefix
        "https://www.tiktok.com/", // Missing username
        "http://www.tiktok.com/@username", // Wrong protocol
        "https://www.tiktok.com/@user name", // Spaces not allowed
      ],
    };

    // Test valid URLs
    for (const [platform, urls] of Object.entries(validLinkUrls)) {
      for (const url of urls) {
        assert.equal(
          isValidURL(url, platform as keyof typeof validLinkUrls),
          true,
          `Expected valid but failed: ${platform} - ${url}`,
        );
      }
    }

    // Test invalid URLs
    for (const [platform, urls] of Object.entries(invalidLinkUrls)) {
      for (const url of urls) {
        assert.equal(
          isValidURL(url, platform as keyof typeof invalidLinkUrls),
          false,
          `Expected invalid but passed: ${platform} - ${url}`,
        );
      }
    }
  });
});
