/**
 * Reads ASSETS_OPS_JSON and prints env assignments for bash eval or dotenv.
 * Existing process.env values win (not overwritten) when format is `export`.
 *
 * OPS_ENV_FORMAT:
 *   export (default) — `export KEY='value'` for `eval "$(…)"`
 *   dotenv           — `KEY=value` lines for `.ops.env` (always writes all set keys)
 *
 * Expected JSON shape (all fields optional; use your own values):
 * {
 *   "gcpProjectId": "…",
 *   "intakeBucket": "…",
 *   "staticBucket": "…",
 *   "staticBucketProjectId": "…",
 *   "assetBaseUrl": "https://cdn.example.com/<prefix>/",
 *   "bucketPrefix": "<prefix>/",
 *   "earnBucket": "…"
 * }
 *
 * Build: `./yarn build:ops-scripts` → `build/scripts/ops-config-exports.js`
 * Run: `./yarn node build/scripts/ops-config-exports.js`
 */

type OpsConfigJson = {
  gcpProjectId?: unknown;
  intakeBucket?: unknown;
  staticBucket?: unknown;
  staticBucketProjectId?: unknown;
  assetBaseUrl?: unknown;
  bucketPrefix?: unknown;
  earnBucket?: unknown;
};

function parseOpsConfig(raw: string): OpsConfigJson {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ASSETS_OPS_JSON must be a JSON object");
  }
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return String(value);
}

const cfg = parseOpsConfig(process.env.ASSETS_OPS_JSON ?? "");
const format = process.env.OPS_ENV_FORMAT === "dotenv" ? "dotenv" : "export";

const pairs: Record<string, string | undefined> = {
  GCP_PROJECT_ID: optionalString(cfg.gcpProjectId),
  INTAKE_BUCKET: optionalString(cfg.intakeBucket),
  STATIC_BUCKET: optionalString(cfg.staticBucket),
  STATIC_BUCKET_PROJECT_ID: optionalString(cfg.staticBucketProjectId),
  ASSET_BASE_URL: optionalString(cfg.assetBaseUrl),
  BUCKET_PREFIX: optionalString(cfg.bucketPrefix),
  EARN_BUCKET: optionalString(cfg.earnBucket),
};

for (const [key, value] of Object.entries(pairs)) {
  if (value == null || value === "") continue;
  if (format === "export" && process.env[key]) continue;
  const text = value;
  if (format === "dotenv") {
    // Quote when needed; escape backslashes and double quotes
    const needsQuote = /[\s#"'$\\]/.test(text);
    const line = needsQuote
      ? `${key}="${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
      : `${key}=${text}`;
    process.stdout.write(`${line}\n`);
  } else {
    const escaped = text.replace(/'/g, "'\\''");
    process.stdout.write(`export ${key}='${escaped}'\n`);
  }
}
