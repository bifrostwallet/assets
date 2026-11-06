import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { BUCKET_PREFIX } from "../src/config.js";
import { getContracts } from "../src/contracts.js";
import { collectUploads } from "../src/script/bucketUpload.js";

function contractLogoKeys(): string[] {
  const dataDir = path.join(process.cwd(), "data");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name !== "logo.webp") continue;
      found.push(path.relative(dataDir, fullPath).split(path.sep).join("/"));
    }
  };
  walk(path.join(dataDir, "contracts"));
  return found.sort();
}

test("bucket upload lists no JSON", () => {
  const uploads = collectUploads();
  assert.equal(
    uploads.length > 0 &&
      !uploads.some(
        (item) => item.destination.endsWith(".json") || item.localPath.endsWith(".json"),
      ),
    true,
  );
});

test("bucket upload includes contract logos", () => {
  const logos = contractLogoKeys();
  assert.equal(logos.length > 0, true);
  const byDestination = new Map(collectUploads().map((item) => [item.destination, item]));
  for (const logo of logos) {
    assert.equal(logo.startsWith("contracts/"), true, logo);
    const item = byDestination.get(`${BUCKET_PREFIX}${logo}`);
    assert.ok(item, logo);
    assert.equal(path.resolve(item.localPath), path.resolve(process.cwd(), "data", logo));
    assert.equal(item.contentType, "image/webp");
  }
  for (const contract of getContracts()) {
    assert.equal(byDestination.has(`${BUCKET_PREFIX}${contract.logoURL}`), true, contract.logoURL);
  }
});
