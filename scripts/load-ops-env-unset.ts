/**
 * Print `export KEY='value'` for dotenv keys in a file that are unset in process.env.
 *
 * Build: `./yarn build:ops-scripts` → `build/scripts/load-ops-env-unset.js`
 * Usage: eval "$(./yarn node build/scripts/load-ops-env-unset.js .ops.env)"
 */
import * as fs from "node:fs";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) process.exit(0);

const text = fs.readFileSync(file, "utf8");
for (const rawLine of text.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  if (process.env[key]) continue;

  let value = line.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
    value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const escaped = value.replace(/'/g, "'\\''");
  process.stdout.write(`export ${key}='${escaped}'\n`);
}
