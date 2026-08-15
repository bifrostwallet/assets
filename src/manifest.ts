import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Signed static-assets manifest (optional CDN root next to providers/, etc.).
 *
 * Trust model: the host is untrusted. Upload signs with Ed25519 (node:crypto);
 * clients embed the publish public key and verify before applying list updates.
 *
 * Signed payload (UTF-8 JSON, stable key order) is:
 *   { "generatedAt": "<iso>", "sections": { ... } }
 * The detached signature is base64url in `signature` (not part of the signed bytes).
 *
 * Browser / dapp verify with Web Crypto Ed25519 over the same UTF-8 bytes
 * (see docs.bifrostwallet.com/list/consuming-assets). No npm dependency required either side.
 */

export interface ManifestChainHashes {
  [chainPath: string]: string;
}

export interface ManifestSection {
  /** SHA-256 hex of the concatenation of per-chain hashes (sorted by chainPath). */
  contentHash: string;
  chains?: ManifestChainHashes;
}

export interface AssetsManifestBody {
  generatedAt: string;
  sections: {
    providers?: ManifestSection;
    executors?: ManifestSection;
    contracts?: ManifestSection;
    dapps?: ManifestSection;
    tokens?: ManifestSection;
  };
}

export interface AssetsManifest extends AssetsManifestBody {
  /** base64url Ed25519 signature over canonical body JSON */
  signature: string;
}

const SECTION_ORDER = ["providers", "executors", "contracts", "dapps", "tokens"] as const;

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Canonical JSON for signing — fixed key order, no whitespace variance. */
export function canonicalManifestBody(body: AssetsManifestBody): string {
  const sections: Record<string, ManifestSection> = {};
  for (const name of SECTION_ORDER) {
    const section = body.sections[name];
    if (!section) continue;
    const entry: ManifestSection = { contentHash: section.contentHash };
    if (section.chains) {
      const chains: ManifestChainHashes = {};
      for (const chain of Object.keys(section.chains).sort()) {
        chains[chain] = section.chains[chain];
      }
      entry.chains = chains;
    }
    sections[name] = entry;
  }
  return JSON.stringify({ generatedAt: body.generatedAt, sections });
}

export function rollupChainHashes(chains: ManifestChainHashes): string {
  const parts: string[] = [];
  for (const chain of Object.keys(chains).sort()) {
    parts.push(`${chain}:${chains[chain]}`);
  }
  return sha256Hex(parts.join("\n"));
}

export function hashFile(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath));
}

export function buildManifestFromDataDir(
  dataDir: string,
  generatedAt = new Date().toISOString(),
): AssetsManifestBody {
  const sections: AssetsManifestBody["sections"] = {};

  const providerChains = listChainAllJson(path.join(dataDir, "providers"));
  if (Object.keys(providerChains).length > 0) {
    sections.providers = {
      contentHash: rollupChainHashes(providerChains),
      chains: providerChains,
    };
  }

  const executorChains = listChainAllJson(path.join(dataDir, "executors"));
  if (Object.keys(executorChains).length > 0) {
    sections.executors = {
      contentHash: rollupChainHashes(executorChains),
      chains: executorChains,
    };
  }

  const contractChains = listChainAllJson(path.join(dataDir, "contracts"));
  if (Object.keys(contractChains).length > 0) {
    sections.contracts = {
      contentHash: rollupChainHashes(contractChains),
      chains: contractChains,
    };
  }

  const dappsAll = path.join(dataDir, "dapps", "all.json");
  if (fs.existsSync(dappsAll)) {
    const hash = hashFile(dappsAll);
    sections.dapps = { contentHash: hash };
  }

  const tokenChains = listChainAllJson(path.join(dataDir, "tokens"));
  if (Object.keys(tokenChains).length > 0) {
    sections.tokens = {
      contentHash: rollupChainHashes(tokenChains),
      chains: tokenChains,
    };
  }

  return { generatedAt, sections };
}

function listChainAllJson(sectionDir: string): ManifestChainHashes {
  const chains: ManifestChainHashes = {};
  if (!fs.existsSync(sectionDir)) return chains;
  for (const entry of fs.readdirSync(sectionDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const allPath = path.join(sectionDir, entry.name, "all.json");
    if (!fs.existsSync(allPath)) continue;
    chains[entry.name] = hashFile(allPath);
  }
  return chains;
}

function loadPrivateKey(): ReturnType<typeof createPrivateKey> {
  const raw = process.env.ASSETS_MANIFEST_PRIVATE_KEY ?? "";
  if (!raw) {
    throw new Error(
      "ASSETS_MANIFEST_PRIVATE_KEY is required to sign the manifest (PKCS8 PEM or base64url seed).",
    );
  }
  if (raw.includes("BEGIN")) {
    return createPrivateKey(raw);
  }
  // Compact: base64url 32-byte seed as raw PKCS8 is awkward; accept PEM only for clarity.
  throw new Error("ASSETS_MANIFEST_PRIVATE_KEY must be an Ed25519 PKCS8 PEM private key");
}

export function signManifestBody(body: AssetsManifestBody): AssetsManifest {
  const message = Buffer.from(canonicalManifestBody(body), "utf8");
  const privateKey = loadPrivateKey();
  const signature = sign(null, message, privateKey).toString("base64url");
  return { ...body, signature };
}

export function verifyManifest(manifest: AssetsManifest, publicKeyPem: string): boolean {
  const { signature, ...body } = manifest;
  const message = Buffer.from(canonicalManifestBody(body), "utf8");
  const publicKey = createPublicKey(publicKeyPem);
  return verify(null, message, publicKey, Buffer.from(signature, "base64url"));
}

/** Generate a one-off Ed25519 keypair (PEM). Run locally; store private in Secret Manager. */
export function generateManifestKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
