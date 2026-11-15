import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { applyChainDrift } from "../src/chainDrift.js";
import type { ProviderInfo } from "../src/config.js";
import { biomeStdinPath, sortProviderInfo, writeFormattedJson } from "../src/convert.js";

const require = createRequire(import.meta.url);

/**
 * What `biome format` emits for this payload. Independent of writeFormattedJson
 * so the assertion is the formatter CLI, not the helper calling itself.
 */
function biomeFormat(filePath: string, value: unknown): string {
  const biomeBin = require.resolve("@biomejs/biome/bin/biome");
  const json = `${JSON.stringify(value, null, 2)}\n`;
  // The tests write to a temporary directory. Biome is given the same file
  // name inside the repository: it crashes on an existing path outside it.
  const stdinPath = path.join("data", path.basename(filePath));
  return execFileSync(process.execPath, [biomeBin, "format", "--stdin-file-path", stdinPath], {
    cwd: process.cwd(),
    input: json,
    encoding: "utf8",
  });
}

/** One-element validators array: JSON.stringify expands it, Biome collapses it. */
function sampleInfo(): ProviderInfo {
  return {
    name: "Example",
    description: "Example provider",
    websiteURL: "https://example.com",
    links: {},
    logoURL: "providers/eip155-14/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/logo.webp",
    logoHash: "ab".repeat(32),
    identityAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    delegationAddress: "0x1111111111111111111111111111111111111111",
    signingPolicyAddress: "0x2222222222222222222222222222222222222222",
    submitAddress: "0x3333333333333333333333333333333333333333",
    submitSignaturesAddress: "0x4444444444444444444444444444444444444444",
    publicKey: `0x${"a".repeat(128)}`,
    validators: ["NodeID-2q436GJKA5faTceNaAbu7CYxftv3K8fS4"],
    listed: true,
    managementGroup: false,
    domainLinked: false,
    dualNetwork: false,
  };
}

describe("biomeStdinPath", () => {
  const root = path.join(path.sep, "work", "assets");

  test("passes a path inside the repository relative to it", () => {
    const inside = path.join("data", "providers", "eip155-14", "0xabc", "info.json");
    assert.equal(biomeStdinPath(path.join(root, inside), root), inside);
    assert.equal(biomeStdinPath(inside, root), inside);
  });

  test("replaces a path outside the repository with the file name under data/", () => {
    const outside = path.join(os.tmpdir(), "chain-drift-format-abc", "info.json");
    assert.equal(biomeStdinPath(outside, root), path.join("data", "info.json"));
    assert.equal(
      biomeStdinPath(path.join(root, "..", "elsewhere", "signatures.json"), root),
      path.join("data", "signatures.json"),
    );
  });
});

describe("provider info.json matches biome format", () => {
  test("writeFormattedJson collapses short arrays the way biome format does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "info-json-format-"));
    const infoPath = path.join(dir, "info.json");
    try {
      const sorted = sortProviderInfo(sampleInfo());
      const expanded = `${JSON.stringify(sorted, null, 2)}\n`;
      const formatted = biomeFormat(infoPath, sorted);
      assert.notEqual(formatted, expanded);

      writeFormattedJson(infoPath, sorted);
      assert.equal(fs.readFileSync(infoPath, "utf8"), formatted);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("applyChainDrift writes info.json equal to biome format", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-drift-format-"));
    const infoPath = path.join(dir, "info.json");
    try {
      const info = sampleInfo();
      fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);

      const nextDelegation = "0x9999999999999999999999999999999999999999";
      const updated = applyChainDrift([
        {
          chainPath: "not-a-catalog-chain",
          identityAddress: info.identityAddress,
          name: info.name,
          infoPath,
          changes: [
            {
              field: "delegationAddress",
              catalog: info.delegationAddress,
              chain: nextDelegation,
            },
          ],
          observed: { delegationAddress: nextDelegation },
        },
      ]);
      assert.equal(updated, 1);

      const expected = sortProviderInfo({ ...info, delegationAddress: nextDelegation });
      const expanded = `${JSON.stringify(expected, null, 2)}\n`;
      const written = fs.readFileSync(infoPath, "utf8");
      assert.equal(written, biomeFormat(infoPath, expected));
      assert.notEqual(written, expanded);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
