import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, mock, test } from "node:test";
import {
  calculateHash,
  decodeNodeID,
  encodeNodeID,
  sortProviderInfo,
  toRelativePath,
} from "../src/convert.js";
import { type HexString, isValidNodeID } from "../src/validate.js";

describe("convert.ts tests", () => {
  test("encodeNodeID() and decodeNodeID() behave as expected", () => {
    const testCases: [string, HexString][] = [
      ["NodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4v", "0x96088bd06737250f00a21254881458ae8ecdc032"],
      ["NodeID-GZEWkCpn852hwKhbGNJgZvbjtvEfU6Ktg", "0xaaa27a3c99f6bcc65e8b891890b8c8d5f2ebb173"],
      ["NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9", "0x0824b9b47ef6f99c26bc10dd042ef35aa69f16ed"],
      ["NodeID-P4T4uKqveVxjZZXVdADHENdnCKnsCFvDE", "0xf1f9c6662fe665665132291be705f87ad86f557f"],
      ["NodeID-5QFVCtJieViQm5gCtTn3mNBqvGunCGWn1", "0x304629ad7c373d06d9a43a13d526b1ec4b26511a"],
    ];

    for (const [nodeID, expectedHex] of testCases) {
      const decoded = decodeNodeID(nodeID);
      assert.equal(decoded, expectedHex);
    }

    for (const [nodeID, expectedHex] of testCases) {
      const encoded = encodeNodeID(expectedHex);
      assert.equal(encoded, nodeID);
      assert.equal(isValidNodeID(encoded), true);
    }

    // Test round-trip conversion
    for (const [nodeID, hex] of testCases) {
      const encoded = encodeNodeID(hex);
      const decoded = decodeNodeID(encoded);
      assert.equal(encoded, nodeID);
      assert.equal(decoded, hex);
    }

    // Test invalid inputs — anything rejected by isValidNodeID must decode to ""
    // (NodeIDs can be 32 or 33 base58 chars, so a 32-char ID is still valid)
    const invalidInputs = [
      "",
      "NodeID",
      "NodeID-",
      "NotANodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4v",
      "NodeID-invalid",
      "NodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4v_",
      "NodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4vAA", // Too long
    ];

    for (const invalidInput of invalidInputs) {
      assert.equal(isValidNodeID(invalidInput), false);
      assert.equal(decodeNodeID(invalidInput), "");
    }
  });

  test("calculateHash() behaves as expected", () => {
    // Mock fs functions
    const mockExistsSync = mock.method(fs, "existsSync", (() => true) as typeof fs.existsSync);
    const mockReadFileSync = mock.method(fs, "readFileSync", (() =>
      Buffer.from("test content")) as unknown as typeof fs.readFileSync);
    const mockConsoleInfo = mock.method(console, "info", () => {});

    try {
      // Expected hash for "test content" is 6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72
      const expectedHash = "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72";
      const result = calculateHash("/path/to/file.txt");

      assert.equal(result, expectedHash);
      assert.ok(
        mockReadFileSync.mock.calls.some((call) => call.arguments[0] === "/path/to/file.txt"),
      );

      // Test with non-existent file
      mockExistsSync.mock.mockImplementation((() => false) as typeof fs.existsSync);
      const emptyResult = calculateHash("/path/to/nonexistent.txt");

      assert.equal(emptyResult, "");
      assert.ok(
        mockConsoleInfo.mock.calls.some((call) =>
          String(call.arguments[0]).includes("File not found"),
        ),
      );
    } finally {
      mockExistsSync.mock.restore();
      mockReadFileSync.mock.restore();
      mockConsoleInfo.mock.restore();
    }
  });

  test("sortProviderInfo() correctly sorts provider info object", () => {
    // Create an unsorted provider info object with properties in random order
    const unsortedInfo = {
      validators: [
        "NodeID-NFBbbJ4qCmNaCzeW7sxErhvWqvEQMnYcN",
        "NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg",
        "NodeID-MFrZFVCXPv5iCn6M9K6XdwVTK7qVUME4U",
      ],
      publicKey: `0x${"a".repeat(128)}`,
      description: "This is a test description for the provider.",
      name: "Test Provider",
      logoHash: "6ae8a75555209fd6c44157c0aed8016e763ff435a19cf186f76863140143ff72",
      websiteURL: "https://example.com",
      logoURL: "https://example.com/logo.png",
      identityAddress: "0x486aC9352F2001d1f43B9c02622Aa26099b86609",
      delegationAddress: "0x586aC9352F2001d1f43B9c02622Aa26099b86610",
      signingPolicyAddress: "0x686aC9352F2001d1f43B9c02622Aa26099b86611",
      submitAddress: "0x786aC9352F2001d1f43B9c02622Aa26099b86612",
      submitSignaturesAddress: "0x886aC9352F2001d1f43B9c02622Aa26099b86613",
      links: {
        github: "https://github.com/username",
        discord: "https://discord.gg/invite",
        x: "https://x.com/username",
        telegram: "https://t.me/username",
        linkedin: "https://www.linkedin.com/in/username",
      },
    };

    // Sort the provider info
    const sortedInfo = sortProviderInfo(unsortedInfo);

    // Check that arrays are sorted correctly
    assert.deepEqual(sortedInfo.validators, [
      "NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg",
      "NodeID-MFrZFVCXPv5iCn6M9K6XdwVTK7qVUME4U",
      "NodeID-NFBbbJ4qCmNaCzeW7sxErhvWqvEQMnYcN",
    ]);

    // Check that object properties are in the expected order
    const mainKeys = Object.keys(sortedInfo);
    assert.deepEqual(mainKeys, [
      "name",
      "description",
      "logoURL",
      "logoHash",
      "websiteURL",
      "links",
      "identityAddress",
      "delegationAddress",
      "signingPolicyAddress",
      "submitAddress",
      "submitSignaturesAddress",
      "publicKey",
      "validators",
    ]);

    // Check that links properties are in the expected order
    const linksKeys = Object.keys(sortedInfo.links ?? {});
    assert.ok(linksKeys.indexOf("github") < linksKeys.indexOf("x"));
    assert.ok(linksKeys.indexOf("x") < linksKeys.indexOf("discord"));
    assert.ok(linksKeys.indexOf("discord") < linksKeys.indexOf("telegram"));
    assert.ok(linksKeys.indexOf("telegram") < linksKeys.indexOf("linkedin"));
  });
});

describe("convert.ts tests (round two)", () => {
  test("encodeNodeID() and decodeNodeID() work correctly", () => {
    // Valid node hex strings and their expected NodeID encodings
    const validPairs = [
      {
        hex: "0x0824b9b47ef6f99c26bc10dd042ef35aa69f16ed" as HexString,
        nodeID: "NodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9",
      },
      {
        hex: "0xf1f9c6662fe665665132291be705f87ad86f557f" as HexString,
        nodeID: "NodeID-P4T4uKqveVxjZZXVdADHENdnCKnsCFvDE",
      },
      {
        hex: "0x304629ad7c373d06d9a43a13d526b1ec4b26511a" as HexString,
        nodeID: "NodeID-5QFVCtJieViQm5gCtTn3mNBqvGunCGWn1",
      },
      {
        hex: "0x96088bd06737250f00a21254881458ae8ecdc032" as HexString,
        nodeID: "NodeID-EgJba99Q5iDcL81A27E111WANn9eZNj4v",
      },
      {
        hex: "0xaaa27a3c99f6bcc65e8b891890b8c8d5f2ebb173" as HexString,
        nodeID: "NodeID-GZEWkCpn852hwKhbGNJgZvbjtvEfU6Ktg",
      },
    ];

    // Test encoding
    for (const pair of validPairs) {
      const encoded = encodeNodeID(pair.hex);
      assert.equal(encoded, pair.nodeID);
      assert.equal(isValidNodeID(encoded), true);
    }

    // Test decoding
    for (const pair of validPairs) {
      const decoded = decodeNodeID(pair.nodeID);
      assert.equal(decoded, pair.hex);
    }

    // Test invalid inputs
    assert.equal(encodeNodeID("0xinvalid"), "");
    assert.equal(decodeNodeID("NotANodeID-k4QG8eJ9bYu717nbj8Ki8VykK8g1VWK9"), "");
  });

  test("toRelativePath() converts absolute paths to relative", () => {
    const cwd = process.cwd();
    const absolutePath = path.join(cwd, "test", "file.txt");
    const expected = path.join("test", "file.txt");

    assert.equal(toRelativePath(absolutePath), expected);
  });

  test("sortProviderInfo() sorts provider info object correctly", () => {
    const unsortedInfo = {
      links: {
        youtube: "https://www.youtube.com/@example",
        x: "https://x.com/example",
        github: "https://github.com/example",
      },
      description: "Example description",
      name: "Example Provider",
      validators: [
        "NodeID-NFBbbJ4qCmNaCzeW7sxErhvWqvEQMnYcN",
        "NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg",
      ],
    };

    const sortedInfo = sortProviderInfo(unsortedInfo);

    // Check that keys are in the expected order
    const keys = Object.keys(sortedInfo);
    assert.ok(keys.indexOf("name") < keys.indexOf("description"));

    // Check that validators are sorted alphabetically
    assert.deepEqual(sortedInfo.validators, [
      "NodeID-7Xhw2mDxuDS44j42TCB6U5579esbSt3Lg",
      "NodeID-NFBbbJ4qCmNaCzeW7sxErhvWqvEQMnYcN",
    ]);

    // Check that links are sorted according to ALLOWED_LINKS order
    const linksKeys = Object.keys(sortedInfo.links || {});
    assert.ok(linksKeys.indexOf("github") < linksKeys.indexOf("x"));
    assert.ok(linksKeys.indexOf("x") < linksKeys.indexOf("youtube"));
  });

  test("calculateHash() returns SHA256 hash of a file", () => {
    // Mock fs.existsSync and fs.readFileSync
    const testContent = "test content";
    const expectedHash = crypto.createHash("sha256").update(testContent).digest("hex");

    const mockExistsSync = mock.method(fs, "existsSync", (() => true) as typeof fs.existsSync);
    const mockReadFileSync = mock.method(fs, "readFileSync", (() =>
      Buffer.from(testContent)) as unknown as typeof fs.readFileSync);
    const consoleSpy = mock.method(console, "info", () => {});

    try {
      assert.equal(calculateHash("/path/to/file.txt"), expectedHash);

      // Test with non-existent file
      mockExistsSync.mock.mockImplementation((() => false) as typeof fs.existsSync);

      assert.equal(calculateHash("/path/to/nonexistent.txt"), "");
      assert.ok(consoleSpy.mock.calls.length > 0);
    } finally {
      mockExistsSync.mock.restore();
      mockReadFileSync.mock.restore();
      consoleSpy.mock.restore();
    }
  });
});
