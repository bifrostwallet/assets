import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Storage } from "@google-cloud/storage";
import { getAssetBaseURL, withAbsoluteLogoURL } from "../assetUrl.js";
import { BUCKET_NAME, BUCKET_PREFIX, PROJECT_ID } from "../config.js";
import { isMain } from "../isMain.js";
import { legacyTokenIconDestination } from "../legacyTokenIcon.js";
import {
  type AssetsManifestBody,
  rollupChainHashes,
  sha256Hex,
  signManifestBody,
} from "../manifest.js";

// Uploads curated assets to an operator-configured static GCS bucket (optional CDN).
//
// Object keys mirror relative paths under data/, optionally under BUCKET_PREFIX.
// Published all.json logoURL values are rewritten to ASSET_BASE_URL (default:
// GitHub raw from package.json repository). For a private CDN, set e.g.:
//   BUCKET_PREFIX=<prefix>/
//   ASSET_BASE_URL=https://cdn.example.com/<prefix>/
//
// Also uploads a signed root manifest.json (Ed25519 via ASSETS_MANIFEST_PRIVATE_KEY)
// whose content hashes match the uploaded all.json bytes.
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
  /** Temp files created for rewritten all.json / manifest — delete after upload */
  cleanup?: boolean;
}

/** Logos are content-addressed via logoHash — cache up to a week */
const LOGO_CACHE_CONTROL = "public, max-age=604800";
/** Lists refresh with nightly builds — cache up to a day */
const LIST_CACHE_CONTROL = "public, max-age=86400";
/** Manifest is the cache-bust signal — cache up to an hour */
const MANIFEST_CACHE_CONTROL = "public, max-age=3600";

function rewriteAllJsonForUpload(
  localPath: string,
  assetBase: string,
): { body: string; tmpPath: string } {
  const entries = JSON.parse(fs.readFileSync(localPath, "utf8")) as Array<{ logoURL?: string }>;
  const rewritten = entries.map((entry) =>
    entry.logoURL ? withAbsoluteLogoURL({ ...entry, logoURL: entry.logoURL }, assetBase) : entry,
  );
  const body = `${JSON.stringify(rewritten, null, 2)}\n`;
  const tmpPath = path.join(
    os.tmpdir(),
    `assets-${path.basename(path.dirname(localPath))}-all-${process.pid}.json`,
  );
  fs.writeFileSync(tmpPath, body);
  return { body, tmpPath };
}

function collectUploads(assetBase: string): {
  uploads: UploadItem[];
  sectionHashes: AssetsManifestBody["sections"];
} {
  const dataDir = path.join(process.cwd(), "data");
  const uploads: UploadItem[] = [];
  const providerChains: Record<string, string> = {};
  const tokenChains: Record<string, string> = {};

  const legacyIcons = new Map<string, string>();

  const walk = (dir: string, section: "providers" | "tokens"): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, section);
        continue;
      }

      const relative = path.relative(dataDir, fullPath).split(path.sep).join("/");

      if (entry.name === "logo.webp") {
        uploads.push({
          localPath: fullPath,
          destination: `${BUCKET_PREFIX}${relative}`,
          cacheControl: LOGO_CACHE_CONTROL,
          contentType: "image/webp",
        });
        if (section === "tokens") {
          const legacyDestination = legacyTokenIconDestination(relative);
          if (legacyDestination) {
            const existing = legacyIcons.get(legacyDestination);
            if (existing && existing !== fullPath) {
              console.warn(
                `⚠️  ${legacyDestination} already queued from ${existing}; keeping the first logo`,
              );
            } else if (!existing) {
              legacyIcons.set(legacyDestination, fullPath);
            }
          }
        }
      } else if (entry.name === "all.json") {
        const { body, tmpPath } = rewriteAllJsonForUpload(fullPath, assetBase);
        const chain = path.basename(path.dirname(fullPath));
        const hash = sha256Hex(body);
        if (section === "providers") providerChains[chain] = hash;
        else tokenChains[chain] = hash;

        uploads.push({
          localPath: tmpPath,
          destination: `${BUCKET_PREFIX}${relative}`,
          cacheControl: LIST_CACHE_CONTROL,
          contentType: "application/json",
          cleanup: true,
        });
      } else if (section === "tokens" && entry.name === "blocklist.json") {
        const body = fs.readFileSync(fullPath);
        tokenChains.blocklist = sha256Hex(body);
        uploads.push({
          localPath: fullPath,
          destination: `${BUCKET_PREFIX}${relative}`,
          cacheControl: LIST_CACHE_CONTROL,
          contentType: "application/json",
        });
      }
      // info.json / signatures.json / provenance.json are repo-internal (not CDN)
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

  // Contract logos only. Lists stay in per-address files and the NPM package.
  const contractsDir = path.join(dataDir, "contracts");
  if (fs.existsSync(contractsDir)) {
    const walkContracts = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkContracts(fullPath);
          continue;
        }
        const relative = path.relative(dataDir, fullPath).split(path.sep).join("/");
        if (entry.name.endsWith(".webp")) {
          uploads.push({
            localPath: fullPath,
            destination: `${BUCKET_PREFIX}${relative}`,
            cacheControl: LOGO_CACHE_CONTROL,
            contentType: "image/webp",
          });
        }
      }
    };
    walkContracts(contractsDir);
  }

  const sections: AssetsManifestBody["sections"] = {};
  if (Object.keys(providerChains).length > 0) {
    sections.providers = {
      contentHash: rollupChainHashes(providerChains),
      chains: providerChains,
    };
  }
  if (Object.keys(tokenChains).length > 0) {
    sections.tokens = {
      contentHash: rollupChainHashes(tokenChains),
      chains: tokenChains,
    };
  }

  const dappsAll = path.join(dataDir, "dapps", "all.json");
  if (fs.existsSync(dappsAll)) {
    const { body, tmpPath } = rewriteAllJsonForUpload(dappsAll, assetBase);
    sections.dapps = { contentHash: sha256Hex(body) };
    uploads.push({
      localPath: tmpPath,
      destination: `${BUCKET_PREFIX}dapps/all.json`,
      cacheControl: LIST_CACHE_CONTROL,
      contentType: "application/json",
      cleanup: true,
    });
  }

  return { uploads, sectionHashes: sections };
}

function buildSignedManifestUpload(sections: AssetsManifestBody["sections"]): UploadItem {
  const body: AssetsManifestBody = {
    generatedAt: new Date().toISOString(),
    sections,
  };
  const signed = signManifestBody(body);
  const tmpPath = path.join(os.tmpdir(), `assets-manifest-${process.pid}.json`);
  fs.writeFileSync(tmpPath, `${JSON.stringify(signed, null, 2)}\n`);
  return {
    localPath: tmpPath,
    destination: `${BUCKET_PREFIX}manifest.json`,
    cacheControl: MANIFEST_CACHE_CONTROL,
    contentType: "application/json",
    cleanup: true,
  };
}

function requireUploadConfig(): { bucketName: string; projectId: string } {
  if (!BUCKET_NAME || !PROJECT_ID) {
    throw new Error(
      "STATIC_BUCKET and STATIC_BUCKET_PROJECT_ID are required. Run via ./yarn with:ops-config -- ./yarn upload:bucket",
    );
  }
  return { bucketName: BUCKET_NAME, projectId: PROJECT_ID };
}

function cleanupTemps(uploads: UploadItem[]): void {
  for (const item of uploads) {
    if (!item.cleanup) continue;
    try {
      fs.unlinkSync(item.localPath);
    } catch {
      // best-effort
    }
  }
}

async function uploadToBucket(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const { bucketName, projectId } = requireUploadConfig();
  const assetBase = getAssetBaseURL();
  const { uploads, sectionHashes } = collectUploads(assetBase);

  let manifestItem: UploadItem | undefined;
  try {
    manifestItem = buildSignedManifestUpload(sectionHashes);
    uploads.push(manifestItem);
  } catch (error) {
    if (dryRun) {
      console.warn(
        "⚠️  Manifest unsigned in dry-run (set ASSETS_MANIFEST_PRIVATE_KEY to sign):",
        error,
      );
      console.info(
        "   Manifest body preview:",
        JSON.stringify({ generatedAt: new Date().toISOString(), sections: sectionHashes }, null, 2),
      );
    } else {
      cleanupTemps(uploads);
      throw error;
    }
  }

  console.info(`🖼️  logoURL base: ${assetBase}`);
  console.info(
    `${dryRun ? "🔍 Dry run: would upload" : "☁️ Uploading"} ${uploads.length} object(s) to gs://${bucketName}/${BUCKET_PREFIX}`,
  );

  if (dryRun) {
    for (const item of uploads) {
      console.info(`   ${item.destination} (${item.cacheControl})`);
    }
    cleanupTemps(uploads);
    return;
  }

  const storage = new Storage({ projectId });
  const bucket = storage.bucket(bucketName);

  let completed = 0;
  const concurrency = 16;
  const queue = [...uploads];

  try {
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
  } finally {
    cleanupTemps(uploads);
  }
}

if (isMain(import.meta.url)) {
  uploadToBucket().catch((error) => {
    console.error("❌ Bucket upload failed:", error);
    process.exitCode = 1;
  });
}

export default uploadToBucket;
