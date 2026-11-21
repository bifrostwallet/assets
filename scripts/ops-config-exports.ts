/**
 * Reads ASSETS_OPS_JSON and prints env assignments for bash eval or dotenv.
 * Existing process.env values win (not overwritten) when format is `export`.
 *
 * OPS_ENV_FORMAT:
 *   export (default) — `export KEY='value'` for `eval "$(…)"`
 *   dotenv           — `KEY=value` lines for `.ops.env` (always writes all set keys)
 *
 * Expected JSON shape (all fields optional; use your own values).
 * assetBaseUrl is the public URL where you uploaded data/.
 * {
 *   "intakeBucket": "…",
 *   "assetBaseUrl": "https://assets.example.com/"
 * }
 *
 * Build: `./yarn build:ops-scripts` → `build/scripts/ops-config-exports.js`
 * Run: `./yarn node build/scripts/ops-config-exports.js`
 */

type OpsConfigJson = {
  intakeBucket?: unknown;
  assetBaseUrl?: unknown;
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
  INTAKE_BUCKET: optionalString(cfg.intakeBucket),
  ASSET_BASE_URL: optionalString(cfg.assetBaseUrl),
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
