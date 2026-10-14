export type ChainName = "flare" | "songbird";

export interface ChainConfig {
  name: ChainName;
  chainPath: string;
  /** Only Flare has P-chain staking (MIRROR claims + validator rewards). */
  hasValidators: boolean;
}

export const CHAINS: ChainConfig[] = [
  { name: "flare", chainPath: "eip155-14", hasValidators: true },
  { name: "songbird", chainPath: "eip155-19", hasValidators: false },
];

/**
 * Reward epochs last exactly 3.5 days, so a year contains 365.25 / 3.5 epochs.
 * Kept as a ratio so all APY math stays in integers: multiply by NUM, divide
 * by DEN.
 */
export const EPOCHS_PER_YEAR_NUM = 36525n; // 365.25 days x 100
export const EPOCHS_PER_YEAR_DEN = 350n; // 3.5 days x 100
export const EPOCHS_PER_YEAR = Number(EPOCHS_PER_YEAR_NUM) / Number(EPOCHS_PER_YEAR_DEN);

/** Versioned object path prefix; bump on breaking JSON contract changes. */
export const OBJECT_PREFIX = "v1";

/** Backend-only earn objects — not public CDN. */
export const LATEST_CACHE_CONTROL = "private, max-age=300";
export const ARCHIVE_CACHE_CONTROL = "private, max-age=86400";

export interface EarnConfig {
  /** GCS bucket name. Unused when dryRun is set. */
  bucket: string;
  /** Write JSON to the local out/ directory instead of GCS. */
  dryRun: boolean;
}
