import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32c, crc32cBase64 } from "../src/crc32c.js";

describe("crc32c", () => {
  it("matches the standard check value", () => {
    assert.equal(crc32c(Buffer.from("123456789", "ascii")), 0xe3069283);
  });

  it("matches the RFC 3720 test patterns", () => {
    assert.equal(crc32c(Buffer.alloc(32, 0x00)), 0x8a9136aa);
    assert.equal(crc32c(Buffer.alloc(32, 0xff)), 0x62a8ab43);
    assert.equal(crc32c(Uint8Array.from({ length: 32 }, (_, i) => i)), 0x46dd794e);
    assert.equal(crc32c(Uint8Array.from({ length: 32 }, (_, i) => 31 - i)), 0x113fdb5c);
  });

  it("is zero for no bytes", () => {
    assert.equal(crc32c(new Uint8Array(0)), 0);
    assert.equal(crc32cBase64(new Uint8Array(0)), "AAAAAA==");
  });

  it("encodes the checksum as big-endian base64, the form Cloud Storage uses", () => {
    assert.equal(crc32cBase64(Buffer.from("123456789", "ascii")), "4waSgw==");
  });
});
