import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Storage } from "@google-cloud/storage";
import type { ProviderApy, ValidatorApy } from "./apy.js";
import {
  ARCHIVE_CACHE_CONTROL,
  type ChainName,
  type EarnConfig,
  EPOCHS_PER_YEAR,
  LATEST_CACHE_CONTROL,
  OBJECT_PREFIX,
} from "./config.js";

/**
 * The JSON contract for a private earn/backend feed. One object per chain
 * at <prefix>/<chain>/latest.json, plus an immutable per-epoch archive at
 * <prefix>/<chain>/epochs/<fspEpochId>.json written on every ingest.
 *
 * Private GCS only — not under the public static CDN UUID. fspEpochId /
 * stakingEpochId double as ingest state: a run short-circuits when the
 * latest published epochs match what latest.json already records.
 */
export interface EarnData {
  chain: ChainName;
  generatedAt: string; // ISO 8601
  /** Source epoch for provider APYs (fsp-rewards). */
  fspEpochId: number;
  /** Source epoch for validator reward stream (reward-scripts); null on Songbird. */
  stakingEpochId: number | null;
  epochsPerYear: number;
  providers: ProviderApy[];
  validators: ValidatorApy[];
}

export function latestPath(chain: ChainName): string {
  return `${OBJECT_PREFIX}/${chain}/latest.json`;
}

function archivePath(chain: ChainName, fspEpochId: number): string {
  return `${OBJECT_PREFIX}/${chain}/epochs/${fspEpochId}.json`;
}

export interface EarnStore {
  readLatest(chain: ChainName): Promise<EarnData | undefined>;
  write(data: EarnData): Promise<string[]>;
}

class GcsStore implements EarnStore {
  private readonly storage = new Storage();
  private readonly bucketName: string;

  constructor(bucketName: string) {
    this.bucketName = bucketName;
  }

  async readLatest(chain: ChainName): Promise<EarnData | undefined> {
    const file = this.storage.bucket(this.bucketName).file(latestPath(chain));
    try {
      const [contents] = await file.download();
      return JSON.parse(contents.toString("utf8")) as EarnData;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return undefined;
      throw err;
    }
  }

  async write(data: EarnData): Promise<string[]> {
    const bucket = this.storage.bucket(this.bucketName);
    const payload = JSON.stringify(data);
    const paths = [latestPath(data.chain), archivePath(data.chain, data.fspEpochId)];
    const cacheControls = [LATEST_CACHE_CONTROL, ARCHIVE_CACHE_CONTROL];

    for (const [index, objectPath] of paths.entries()) {
      await bucket.file(objectPath).save(payload, {
        contentType: "application/json",
        metadata: { cacheControl: cacheControls[index] },
        resumable: false,
      });
    }
    return paths.map((objectPath) => `gs://${this.bucketName}/${objectPath}`);
  }
}

/** DRY_RUN store: writes to ./out instead of GCS, never reads prior state. */
class LocalStore implements EarnStore {
  private readonly baseDir: string;

  constructor(baseDir = "out") {
    this.baseDir = baseDir;
  }

  async readLatest(): Promise<EarnData | undefined> {
    return undefined;
  }

  async write(data: EarnData): Promise<string[]> {
    const objectPath = join(this.baseDir, latestPath(data.chain));
    await mkdir(dirname(objectPath), { recursive: true });
    await writeFile(objectPath, JSON.stringify(data, null, 2));
    return [objectPath];
  }
}

export function createStore(config: EarnConfig): EarnStore {
  return config.dryRun ? new LocalStore() : new GcsStore(config.bucket);
}

export function buildEarnData(
  chain: ChainName,
  fspEpochId: number,
  stakingEpochId: number | null,
  providers: ProviderApy[],
  validators: ValidatorApy[],
): EarnData {
  return {
    chain,
    generatedAt: new Date().toISOString(),
    fspEpochId,
    stakingEpochId,
    epochsPerYear: EPOCHS_PER_YEAR,
    providers,
    validators,
  };
}
