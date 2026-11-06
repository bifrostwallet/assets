import assert from "node:assert/strict";
import { test } from "node:test";
import { collectUploads } from "../src/script/bucketUpload.js";

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
