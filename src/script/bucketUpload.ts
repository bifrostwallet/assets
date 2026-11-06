import * as fs from "node:fs";
import * as path from "node:path";
import { Storage } from "@google-cloud/storage";
import { BUCKET_NAME, BUCKET_PREFIX, PROJECT_ID } from "../config.js";
import { isMain } from "../isMain.js";
import { legacyTokenIconDestination } from "../legacyTokenIcon.js";

// Uploads logo files to an operator-configured static GCS bucket (optional CDN).
// Catalog JSON, including provider all.json, is not uploaded. The npm package
// serves that data.
//
// Object keys mirror relative paths under data/, optionally under BUCKET_PREFIX.
// For a private CDN, set e.g.:
//   BUCKET_PREFIX=<prefix>/
//
// Each ERC-20 logo.webp is uploaded twice, as the same WebP bytes: the catalog
// object, and `res/icons/<address>.webp` at the bucket root (no prefix). Host
// `/res` reads that key from the production static bucket, so point
// STATIC_BUCKET at production.
//
// Auth uses Application Default Credentials (gcloud auth application-default login).
// Pass --dry-run to preview without uploading.

interface UploadItem {
  localPath: string;
  destination: string;
  cacheControl: string;
  contentType: string;
}

/** Logos are content-addressed via logoHash — cache up to a week */
const LOGO_CACHE_CONTROL = "public, max-age=604800";

export function collectUploads(): UploadItem[] {
  const dataDir = path.join(process.cwd(), "data");
  const uploads: UploadItem[] = [];

  const legacyIcons = new Map<string, string>();

  const walk = (dir: string, section: "providers" | "tokens"): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, section);
        continue;
      }

      // all.json and other JSON stay in git and the npm package.
      if (entry.name !== "logo.webp") continue;

      const relative = path.relative(dataDir, fullPath).split(path.sep).join("/");
      uploads.push({
        localPath: fullPath,
        destination: `${BUCKET_PREFIX}${relative}`,
        cacheControl: LOGO_CACHE_CONTROL,
        contentType: "image/webp",
      });
      if (section !== "tokens") continue;
      const legacyDestination = legacyTokenIconDestination(relative);
      if (!legacyDestination) continue;
      const existing = legacyIcons.get(legacyDestination);
      if (existing && existing !== fullPath) {
        console.warn(
          `⚠️  ${legacyDestination} already queued from ${existing}; keeping the first logo`,
        );
      } else if (!existing) {
        legacyIcons.set(legacyDestination, fullPath);
      }
    }
  };

  for (const section of ["providers", "tokens"] as const) {
    const sectionDir = path.join(dataDir, section);
    if (fs.existsSync(sectionDir)) {
      walk(sectionDir, section);
    }
  }

  for (const [destination, localPath] of legacyIcons) {
    uploads.push({
      localPath,
      destination,
      cacheControl: LOGO_CACHE_CONTROL,
      contentType: "image/webp",
    });
  }

  // Dapp and contract logos. Catalog JSON stays in the npm package; contract
  // logo.webp does not. Keys match published logoURL (contracts/…/logo.webp).
  const walkLogos = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkLogos(fullPath);
        continue;
      }
      if (entry.name !== "logo.webp") continue;
      const relative = path.relative(dataDir, fullPath).split(path.sep).join("/");
      uploads.push({
        localPath: fullPath,
        destination: `${BUCKET_PREFIX}${relative}`,
        cacheControl: LOGO_CACHE_CONTROL,
        contentType: "image/webp",
      });
    }
  };

  for (const section of ["dapps", "contracts"]) {
    const sectionDir = path.join(dataDir, section);
    if (fs.existsSync(sectionDir)) {
      walkLogos(sectionDir);
    }
  }

  return uploads;
}

function requireUploadConfig(): { bucketName: string; projectId: string } {
  if (!BUCKET_NAME || !PROJECT_ID) {
    throw new Error(
      "STATIC_BUCKET and STATIC_BUCKET_PROJECT_ID are required. Run via ./yarn with:ops-config -- ./yarn upload:bucket",
    );
  }
  return { bucketName: BUCKET_NAME, projectId: PROJECT_ID };
}

async function uploadToBucket(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { bucketName, projectId } = requireUploadConfig();
  const uploads = collectUploads();

  console.info(
    `${dryRun ? "🔍 Dry run: would upload" : "☁️ Uploading"} ${uploads.length} object(s) to gs://${bucketName}/${BUCKET_PREFIX}`,
  );

  if (dryRun) {
    for (const item of uploads) {
      console.info(`   ${item.destination} (${item.cacheControl})`);
    }
    return;
  }

  const storage = new Storage({ projectId });
  const bucket = storage.bucket(bucketName);

  let completed = 0;
  const concurrency = 16;
  const queue = [...uploads];

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      await bucket.upload(item.localPath, {
        destination: item.destination,
        metadata: {
          cacheControl: item.cacheControl,
          contentType: item.contentType,
        },
      });

      completed++;
      if (completed % 25 === 0 || completed === uploads.length) {
        console.info(`   ${completed}/${uploads.length}`);
      }
    }
  });

  await Promise.all(workers);
  console.info(`\n✅ Uploaded ${completed} object(s) to gs://${bucketName}/${BUCKET_PREFIX}`);
}

if (isMain(import.meta.url)) {
  uploadToBucket().catch((error) => {
    console.error("❌ Bucket upload failed:", error);
    process.exitCode = 1;
  });
}

export default uploadToBucket;
