import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

const JSDELIVR_MAIN = "https://cdn.jsdelivr.net/gh/bifrostwallet/assets@main/data/";

function walk(dir: string, visit: (filePath: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, visit);
    else visit(fullPath);
  }
}

describe("legacy catalog URLs", () => {
  test("provider all.json logo URLs use jsDelivr @main", () => {
    const providersDir = path.join(process.cwd(), "data", "providers");
    const files = fs
      .readdirSync(providersDir)
      .filter((name) => fs.existsSync(path.join(providersDir, name, "all.json")))
      .map((name) => path.join(providersDir, name, "all.json"));
    assert.ok(files.length >= 2);
    for (const filePath of files) {
      const text = fs.readFileSync(filePath, "utf8");
      assert.equal(text.includes("raw.githubusercontent"), false, filePath);
      const providers = JSON.parse(text) as Array<{ logoURL: string; validators: string[] }>;
      assert.ok(providers.length > 0);
      for (const provider of providers) {
        assert.ok(provider.logoURL.startsWith(JSDELIVR_MAIN), provider.logoURL);
        assert.match(provider.logoURL, /\/providers\/eip155-\d+\/0x[0-9a-f]{40}\/logo\.webp$/);
        assert.ok(Array.isArray(provider.validators));
      }
    }
  });

  test("token catalogs have no all.json", () => {
    const found: string[] = [];
    walk(path.join(process.cwd(), "data", "tokens"), (filePath) => {
      if (path.basename(filePath) === "all.json") found.push(filePath);
    });
    assert.deepEqual(found, []);
    assert.equal(fs.existsSync(path.join(process.cwd(), "data", "validators")), false);
  });
});
