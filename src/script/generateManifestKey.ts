import * as fs from "node:fs";
import * as path from "node:path";
import { isMain } from "../isMain.js";
import { generateManifestKeyPair } from "../manifest.js";

/**
 * Generates an Ed25519 keypair for signing the static assets manifest.
 * - manifest-public.pem (repo root) — commit this; baked into the npm package
 * - manifest-private.pem (repo root, gitignored) — store in Secret Manager as
 *   assets-manifest-private-key, then delete the local file
 *
 * Does not print the private key. Operator notes: bifrostwallet/assets-intake.
 */
function main(): void {
  const { publicKeyPem, privateKeyPem } = generateManifestKeyPair();
  const root = process.cwd();
  const publicPath = path.join(root, "manifest-public.pem");
  const privatePath = path.join(root, "manifest-private.pem");
  fs.writeFileSync(publicPath, publicKeyPem);
  fs.writeFileSync(privatePath, privateKeyPem, { mode: 0o600 });
  console.info(`✅ Wrote public key to ${publicPath} (safe to commit)`);
  console.info(
    `🔒 Wrote private key to ${privatePath} (gitignored — store in Secret Manager, then delete)`,
  );
}

if (isMain(import.meta.url)) {
  main();
}
