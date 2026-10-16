import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { legacyTokenIconDestination } from "../src/legacyTokenIcon.js";

const APS = "0xff56eb5b1a7faa972291117e5e9565da29bc808d";

describe("legacy token icon destination", () => {
  test("maps a catalog logo to the address WebP at the bucket root", () => {
    assert.equal(
      legacyTokenIconDestination(`tokens/eip155-14/${APS}/logo.webp`),
      `res/icons/${APS}.webp`,
    );
  });

  test("ignores provider logos and other catalog files", () => {
    assert.equal(legacyTokenIconDestination(`providers/eip155-14/${APS}/logo.webp`), undefined);
    assert.equal(legacyTokenIconDestination("tokens/eip155-14/all.json"), undefined);
    assert.equal(legacyTokenIconDestination("tokens/eip155-14/0xabc/logo.webp"), undefined);
  });
});
