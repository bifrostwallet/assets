import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { withRelativeLogoURL } from "../assetUrl.js";
import {
  ALLOWED_LINKS,
  DAPP_CATEGORIES,
  DAPP_CATEGORY_LABELS,
  jsDelivrDataBaseFromRepository,
  type ProviderInfo,
} from "../config.js";
import {
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  type ContractInfo,
  chainPathToCaip2,
  getContracts,
  listContractChainPaths,
  validateContractCatalog,
} from "../contracts.js";
import { collectDappLogoErrors } from "../dappCheck.js";
import {
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_SALT,
  EIP712_DOMAIN_VERSION,
  PROVIDER_LISTING_PRIMARY_TYPE,
  PROVIDER_LISTING_TYPES,
} from "../eip712.js";
import { isMain } from "../isMain.js";
import { assertJsDelivrReleaseBase, releaseTagForVersion } from "../releaseTag.js";
import { type EvmToken, listChainTokens, listTokenChainPaths } from "../tokens.js";
import type { XrplToken } from "../xrplToken.js";

// Builds the publishable @bifrostwallet/assets NPM package into dist/.
//
// The published artifact is ZERO-DEPENDENCY by design: JSON data plus small pure
// CommonJS helpers and TypeScript declarations. All tooling (viem, GCS)
// stays in this repository's devDependencies and is never shipped.
//
// Published JSON keeps logoURL relative (providers/…, tokens/…, contracts/…).
// Provider all.json in git uses absolute GitHub URLs; withRelativeLogoURL strips them.
// Tokens are read from each info.json. There is no token all.json. Logo files are not bundled.
// Contract source JSON stores a project slug. This build denormalizes projectName, logoURL, and logoHash onto
// each published contract. createAssets({ baseURL }) is the public catalog entry.
// baseURL is optional. The default is jsDelivr at this release tag
// (`@<version>/data/`). The tag is the package version. That URL is written
// into index.js as a string. index.js does not
// read package.json. The same entry exports the ProviderListing EIP-712 constants
// and providerListingTypedData, copied from src/eip712.ts so the published package
// does not hash the salt or depend on viem. verifyLogoHash checks logo bytes
// against the catalog logoHash. fetch-logos downloads those logos and refuses any file
// whose hash is missing or does not match. Provider signatures ship as a separate
// entry (signatures.js).
// index.js does not load that file. ASSET_BASE_URL is not applied here. Bucket
// upload sends logo files only.
//
// Publish with: ./yarn build:package && npm publish ./dist

const PROVIDER_CHAINS = ["eip155-14", "eip155-19"] as const;

function publishEntry<T extends { logoURL: string }>(entry: T, label: string): T {
  const published = withRelativeLogoURL(entry);
  if (/^https:\/\//i.test(published.logoURL)) {
    throw new Error(`${label}: published logoURL must stay relative, got ${entry.logoURL}`);
  }
  return published;
}

function loadProviders(chainPath: string): ProviderInfo[] {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  const providers = JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
  return providers.map((provider) =>
    publishEntry(provider, `providers/${chainPath}/${provider.identityAddress}`),
  );
}

function loadTokens(chainPath: string): Array<EvmToken | XrplToken> {
  return listChainTokens(chainPath).map((token, index) =>
    publishEntry(token, `tokens/${chainPath}[${index}]`),
  );
}

function loadContracts(chainPath: string): ContractInfo[] {
  // getContracts reads the project slug and fills in projectName, logoURL, and logoHash.
  const contracts = getContracts(chainPathToCaip2(chainPath));
  return contracts.map((contract) => {
    const label = `contracts/${chainPath}/${contract.address}`;
    if (contract.project && !contract.projectName) {
      throw new Error(`${label}: projectName was not resolved`);
    }
    if (!contract.logoURL || !contract.logoHash) {
      throw new Error(`${label}: logo was not resolved`);
    }
    return publishEntry(contract, label);
  });
}

function chainDirToCaip2(chainPath: string): string {
  const splitAt = chainPath.indexOf("-");
  return splitAt === -1
    ? chainPath
    : `${chainPath.slice(0, splitAt)}:${chainPath.slice(splitAt + 1)}`;
}

/** Operator signatures, keyed by CAIP-2 chain then lowercase identity. */
function collectProviderSignatures(): Record<string, Record<string, unknown>> {
  const byChain: Record<string, Record<string, unknown>> = {};
  const root = path.join(process.cwd(), "data", "providers");
  for (const chain of PROVIDER_CHAINS) {
    const identities: Record<string, unknown> = {};
    const chainDir = path.join(root, chain);
    if (fs.existsSync(chainDir)) {
      const dirs = fs
        .readdirSync(chainDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const dir of dirs) {
        const sigPath = path.join(chainDir, dir, "signatures.json");
        if (!fs.existsSync(sigPath)) continue;
        identities[dir.toLowerCase()] = JSON.parse(fs.readFileSync(sigPath, "utf8")) as unknown;
      }
    }
    byChain[chainDirToCaip2(chain)] = identities;
  }
  return byChain;
}

function signaturesRuntimeJs(): string {
  const providerRequires = PROVIDER_CHAINS.map(
    (chain) => `  "${chain}": require("./providers/${chain}.json"),`,
  ).join("\n");
  return `"use strict";
// @bifrostwallet/assets/signatures — generated file, do not edit.
// Opt-in entry. The package main entry does not load this file.

const signaturesByChain = require("./signatures.json");
const providersByChain = {
${providerRequires}
};
const EIP712_DOMAIN_SALT = ${JSON.stringify(EIP712_DOMAIN_SALT)};
const PROVIDER_LISTING_PRIMARY_TYPE = ${JSON.stringify(PROVIDER_LISTING_PRIMARY_TYPE)};
const PROVIDER_LISTING_TYPES = ${JSON.stringify(PROVIDER_LISTING_TYPES)};
const LINK_KEYS = ${JSON.stringify([...ALLOWED_LINKS])};
const LISTING_CHAIN_IDS = { "eip155:14": 14, "eip155:19": 19 };

function normalizeChainId(chainId) {
  if (typeof chainId !== "string" || !Object.hasOwn(LISTING_CHAIN_IDS, chainId)) {
    throw new Error(
      'Use "eip155:14" or "eip155:19". Got: ' + JSON.stringify(chainId)
    );
  }
  return chainId;
}

function getProviderSignatures(chainId, identityAddress) {
  const chain = signaturesByChain[normalizeChainId(chainId)];
  if (!chain) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + Object.keys(signaturesByChain).join(", ")
    );
  }
  const target = String(identityAddress).toLowerCase();
  return Object.hasOwn(chain, target) ? chain[target] : null;
}

function asBytes32(hash) {
  const text = String(hash);
  const raw = text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text;
  const normalized = raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Invalid bytes32 hash: " + hash);
  }
  return "0x" + normalized;
}

function asAddress(value) {
  const normalized = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("Invalid address: " + value);
  }
  return normalized;
}

function listingMessage(provider, contentHash) {
  const source = provider.links && typeof provider.links === "object" ? provider.links : {};
  const links = {};
  for (const key of LINK_KEYS) {
    if (Object.hasOwn(source, key)) links[key] = source[key];
  }
  return {
    name: String(provider.name ?? ""),
    description: String(provider.description ?? ""),
    websiteURL: String(provider.websiteURL ?? ""),
    logoHash: asBytes32(provider.logoHash ?? ""),
    identityAddress: asAddress(provider.identityAddress ?? ""),
    linksJson: JSON.stringify(links),
    acknowledgedResponsibilities: provider.acknowledgedResponsibilities === true,
    contentHash: asBytes32(contentHash),
  };
}

function getProviderListingVerification(chainId, identityAddress) {
  const chain = normalizeChainId(chainId);
  const chainPath = chain.replace(":", "-");
  const providers = providersByChain[chainPath];
  const target = String(identityAddress).toLowerCase();
  const provider = Array.isArray(providers)
    ? providers.find((item) => String(item.identityAddress).toLowerCase() === target)
    : undefined;
  const record = getProviderSignatures(chain, identityAddress);
  const entries = record && Array.isArray(record.signatures) ? record.signatures : [];
  if (!provider || entries.length === 0) return [];
  return entries.map((entry) => ({
    address: entry.signerAddress,
    domain: {
      name: ${JSON.stringify(EIP712_DOMAIN_NAME)},
      version: ${JSON.stringify(EIP712_DOMAIN_VERSION)},
      chainId: LISTING_CHAIN_IDS[chain],
      salt: EIP712_DOMAIN_SALT,
    },
    types: PROVIDER_LISTING_TYPES,
    primaryType: PROVIDER_LISTING_PRIMARY_TYPE,
    message: listingMessage(provider, entry.messageHash),
    signature: entry.signature,
  }));
}

module.exports = { getProviderSignatures, getProviderListingVerification };
`;
}

function signaturesDeclarations(): string {
  const fields = PROVIDER_LISTING_TYPES.ProviderListing.map((field) => {
    const name = JSON.stringify(field.name);
    const type = JSON.stringify(field.type);
    return `      { readonly name: ${name}; readonly type: ${type} },`;
  }).join("\n");
  const salt = JSON.stringify(EIP712_DOMAIN_SALT);
  const domainName = JSON.stringify(EIP712_DOMAIN_NAME);
  const domainVersion = JSON.stringify(EIP712_DOMAIN_VERSION);
  const primaryType = JSON.stringify(PROVIDER_LISTING_PRIMARY_TYPE);
  return `// @bifrostwallet/assets/signatures — generated file, do not edit.
// Opt-in entry. Importing "@bifrostwallet/assets" does not load this module.

export interface ProviderSignature {
  signerName: string;
  signerAddress: string;
  messageHash: string;
  signature: string;
  date: string;
}

export interface ProviderSignatures {
  identityAddress: string;
  verificationInstructions: string;
  signatures: ProviderSignature[];
}

/** Operator signature payload for one identity, or null when this version has none. */
export declare function getProviderSignatures(
  chainId: "eip155:14" | "eip155:19",
  identityAddress: string,
): ProviderSignatures | null;

export interface ProviderListingVerification {
  address: \`0x\${string}\`;
  domain: {
    name: ${domainName};
    version: ${domainVersion};
    chainId: number;
    salt: ${salt};
  };
  types: {
    readonly ProviderListing: readonly [
${fields}
    ];
  };
  primaryType: ${primaryType};
  message: {
    name: string;
    description: string;
    websiteURL: string;
    logoHash: \`0x\${string}\`;
    identityAddress: \`0x\${string}\`;
    linksJson: string;
    acknowledgedResponsibilities: boolean;
    contentHash: \`0x\${string}\`;
  };
  signature: \`0x\${string}\`;
}

/**
 * One viem verifyTypedData / recoverTypedDataAddress argument per signature.
 * Empty when this version has no provider or no signature for that identity.
 */
export declare function getProviderListingVerification(
  chain: "eip155:14" | "eip155:19",
  identityAddress: string,
): ProviderListingVerification[];
`;
}

function writeSignatureSidecar(distDir: string): number {
  const signatures = collectProviderSignatures();
  const count = Object.values(signatures).reduce(
    (sum, chain) => sum + Object.keys(chain).length,
    0,
  );
  fs.writeFileSync(
    path.join(distDir, "signatures.json"),
    `${JSON.stringify(signatures, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(distDir, "signatures.js"), signaturesRuntimeJs());
  fs.writeFileSync(path.join(distDir, "signatures.d.ts"), signaturesDeclarations());
  return count;
}

/** Logo bytes stay in git. The published package is listings, helpers, and the signature sidecar. */
function assertNoBundledLogos(distDir: string): void {
  const bundled: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name !== "logo.webp") continue;
      bundled.push(path.relative(distDir, fullPath).split(path.sep).join("/"));
    }
  };
  walk(distDir);
  if (bundled.length > 0) {
    throw new Error(`Refusing to publish logo.webp files: ${bundled.slice(0, 5).join(", ")}`);
  }
}

const PUBLISHED_EXPORTS = [
  "CONTRACT_CATEGORIES",
  "CONTRACT_CATEGORY_LABELS",
  "CONTRACT_CHAIN_IDS",
  "DAPP_CATEGORIES",
  "DAPP_CATEGORY_LABELS",
  "EIP712_DOMAIN_SALT",
  "PROVIDER_CHAIN_IDS",
  "PROVIDER_LISTING_PRIMARY_TYPE",
  "PROVIDER_LISTING_TYPES",
  "TOKEN_CHAIN_IDS",
  "createAssets",
  "fetchLogo",
  "providerListingTypedData",
  "verifyLogoHash",
] as const;

const LOGO_HASH_RE = /^[0-9a-f]{64}$/;

/** Relative catalog logo path. No scheme, no parent segments. */
function isSafeLogoPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("..") || value.includes("\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^(providers|tokens|contracts|dapps)\/[A-Za-z0-9._@/-]+$/.test(value);
}

/**
 * Each catalog entry's logoHash must match its logo bytes.
 * Shipped providers, tokens, and contracts are read from dist/.
 * Dapp entries stay in data/dapps and are checked from there.
 */
function assertCatalogLogoHashes(distDir: string): number {
  const hashes = new Map<string, string>();
  const add = (logoURL: unknown, logoHash: unknown, label: string): void => {
    if (typeof logoURL !== "string" || !isSafeLogoPath(logoURL)) {
      throw new Error(`${label}: logo path is not a relative data file`);
    }
    if (typeof logoHash !== "string" || !LOGO_HASH_RE.test(logoHash)) {
      throw new Error(`${label}: missing logoHash for ${logoURL}`);
    }
    const existing = hashes.get(logoURL);
    if (existing !== undefined && existing !== logoHash) {
      throw new Error(`${label}: logoHash conflict for ${logoURL}`);
    }
    hashes.set(logoURL, logoHash);
  };

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name === "package.json") continue;
      if (entry.name === "signatures.json") continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object" || !("logoURL" in item)) continue;
        const record = item as { logoURL?: unknown; logoHash?: unknown };
        const label = path.relative(distDir, fullPath);
        add(record.logoURL, record.logoHash, label);
      }
    }
  };
  walk(distDir);

  const dataRoot = path.join(process.cwd(), "data");
  for (const [relative, logoHash] of hashes) {
    const filePath = path.join(dataRoot, relative);
    if (!fs.existsSync(filePath)) {
      throw new Error(`logoHash for ${relative} has no file under data/`);
    }
    const actual = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    if (actual !== logoHash) {
      throw new Error(`${relative}: catalog logoHash does not match logo bytes`);
    }
  }
  const dappLogoErrors = collectDappLogoErrors();
  if (dappLogoErrors.length > 0) {
    throw new Error(
      `Dapp logos do not match their catalog entries:\n${dappLogoErrors.slice(0, 8).join("\n")}`,
    );
  }
  return hashes.size;
}

const VERIFY_LOGO_HASH_JS = [
  "function verifyLogoHash(bytes, expectedHash) {",
  '  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;',
  '  const crypto = require("node:crypto");',
  "  let view;",
  "  if (bytes instanceof ArrayBuffer) view = Buffer.from(bytes);",
  "  else if (ArrayBuffer.isView(bytes)) {",
  "    view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);",
  "  } else return false;",
  '  const digest = crypto.createHash("sha256").update(view).digest();',
  '  const expected = Buffer.from(expectedHash, "hex");',
  "  if (digest.length !== expected.length) return false;",
  "  return crypto.timingSafeEqual(digest, expected);",
  "}",
  "",
  "async function fetchLogo(entry, options) {",
  '  if (!entry || typeof entry.logoURL !== "string" || entry.logoURL.trim() === "") {',
  '    throw new Error("logoURL is required");',
  "  }",
  '  if (typeof entry.logoHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.logoHash)) {',
  '    throw new Error("logoHash must be a lowercase SHA-256 hex digest");',
  "  }",
  "  const fetchImpl = (options && options.fetch) || fetch;",
  "  const signal = options && options.signal ? options.signal : AbortSignal.timeout(30000);",
  "  let response;",
  "  try {",
  "    response = await fetchImpl(entry.logoURL, {",
  '      redirect: "follow",',
  '      headers: { accept: "application/octet-stream" },',
  "      signal,",
  "    });",
  "  } catch (error) {",
  "    const message = error && error.message ? error.message : String(error);",
  '    throw new Error("Could not fetch logo: " + message);',
  "  }",
  "  if (!response || !response.ok) {",
  '    const status = response && response.status ? response.status : "request failed";',
  '    throw new Error("Could not fetch logo: HTTP " + status);',
  "  }",
  "  const bytes = new Uint8Array(await response.arrayBuffer());",
  "  if (bytes.byteLength > 256 * 1024) {",
  '    throw new Error("Could not fetch logo: response exceeds 256KB");',
  "  }",
  "  if (!verifyLogoHash(bytes, entry.logoHash)) {",
  '    throw new Error("logo hash mismatch");',
  "  }",
  "  return bytes;",
  "}",
].join("\n");

function fetchLogosSource(defaultBase: string): string {
  return `#!/usr/bin/env node
"use strict";
// @bifrostwallet/assets fetch-logos — generated file, do not edit.
// Downloads logo files for this package version. Each catalog entry's logoHash
// is the trust anchor. Bytes are the decoded response body (content-encoding removed).
// Accept is application/octet-stream so the CDN is not asked to convert the image.

const fs = require("node:fs");
const path = require("node:path");
const { fetchLogo, verifyLogoHash } = require("./verify-logo-hash.js");

const DEFAULT_LOGO_BASE_URL = ${JSON.stringify(defaultBase)};
const USAGE = [
  "Usage: fetch-logos <dir>",
  "",
  "Download this package version's logos into <dir>.",
  "Paths stay relative to data/ (providers/, tokens/, contracts/, dapps/).",
  "Each file is checked against the logoHash on its catalog entry.",
  "A missing hash or a hash mismatch does not write that file, and the command exits non-zero.",
  "Do not upload the directory when the command fails.",
  "",
  "Upload <dir> to any static host. createAssets baseURL is optional.",
  "Omit it to use jsDelivr at this release tag:",
  ${JSON.stringify(defaultBase)},
  "Or set baseURL to the public URL where you uploaded that directory.",
  "Example: https://assets.example.com/",
  "Run fetch-logos again when you bump the package version.",
].join("\\n");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function walkJsonArrays(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonArrays(fullPath, visit);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    if (entry.name === "package.json" || entry.name === "signatures.json") {
      continue;
    }
    const parsed = readJson(fullPath);
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof item.logoURL === "string") {
        visit(item, path.relative(dir, fullPath));
      }
    }
  }
}

function isSafeLogoPath(value) {
  if (!value || value.startsWith("/") || value.includes("..") || value.includes("\\\\")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^(providers|tokens|contracts|dapps)\\/[A-Za-z0-9._@/-]+$/.test(value);
}

function loadAnchors(packageRoot) {
  const entries = new Map();
  const failures = [];
  walkJsonArrays(packageRoot, (item) => {
    const logoPath = item.logoURL;
    const logoHash = item.logoHash;
    if (!isSafeLogoPath(logoPath)) {
      failures.push(String(logoPath) + ": invalid logo path");
      return;
    }
    if (typeof logoHash !== "string" || !/^[0-9a-f]{64}$/.test(logoHash)) {
      failures.push(logoPath + ": missing logoHash");
      entries.set(logoPath, null);
      return;
    }
    const existing = entries.get(logoPath);
    if (existing !== undefined && existing !== logoHash) {
      failures.push(logoPath + ": logoHash conflict");
      entries.set(logoPath, null);
      return;
    }
    if (existing === undefined) entries.set(logoPath, logoHash);
  });
  return { entries, failures };
}

function destinationFor(destDir, logoPath) {
  const root = path.resolve(destDir);
  const target = path.resolve(root, logoPath);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("logo path escapes destination");
  }
  return target;
}

async function mapPool(items, limit, fn) {
  const queue = items.slice();
  const workers = [];
  const count = Math.min(limit, queue.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

async function fetchLogos(options) {
  if (!options || typeof options.destDir !== "string" || options.destDir.trim() === "") {
    throw new Error("destDir is required");
  }
  const packageRoot = options.packageRoot || __dirname;
  const supplied = typeof options.baseURL === "string" ? options.baseURL.trim() : "";
  const baseURL = (supplied || DEFAULT_LOGO_BASE_URL).replace(/\\/?$/, "/");
  const fetchImpl = options.fetch || fetch;
  const loaded = loadAnchors(packageRoot);
  const failures = loaded.failures.slice();
  const written = [];
  const jobs = [];
  for (const [logoPath, logoHash] of loaded.entries) {
    if (typeof logoHash !== "string") continue;
    jobs.push({ logoPath, logoHash });
  }
  await mapPool(jobs, 8, async (job) => {
    try {
      const bytes = await fetchLogo(
        { logoURL: baseURL + job.logoPath, logoHash: job.logoHash },
        { fetch: fetchImpl },
      );
      const target = destinationFor(options.destDir, job.logoPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const partial = target + ".partial";
      fs.writeFileSync(partial, bytes);
      fs.renameSync(partial, target);
      written.push(job.logoPath);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      failures.push(job.logoPath + ": " + message);
    }
  });
  return { written, failures };
}

async function runCli(argv, deps) {
  const args = Array.isArray(argv) ? argv : [];
  const extra = deps || {};
  if (args.includes("--help") || args.includes("-h")) {
    console.info(USAGE);
    return 0;
  }
  if (args.length !== 1) {
    console.error(USAGE);
    return 1;
  }
  const result = await fetchLogos({
    destDir: args[0],
    packageRoot: extra.packageRoot,
    baseURL: extra.baseURL,
    fetch: extra.fetch,
  });
  for (const failure of result.failures) console.error(failure);
  if (result.failures.length > 0) {
    console.error(
      "fetch-logos failed for " +
        result.failures.length +
        " logo(s). Those files were not written. Do not upload this directory.",
    );
    return 1;
  }
  console.info("Wrote " + result.written.length + " logo(s) to " + args[0]);
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error && error.message ? error.message : error);
      process.exitCode = 1;
    });
}

module.exports = { fetchLogos, fetchLogo, runCli, verifyLogoHash };
`;
}

/** True when `source` contains an absolute URL whose host is exactly `hostname`. */
function sourceContainsHostname(source: string, hostname: string): boolean {
  for (const match of source.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    try {
      if (new URL(match[0]).hostname === hostname) return true;
    } catch {
      // The match is not a URL.
    }
  }
  return false;
}

/** dist/package.json matches this repo, and index.js exposes createAssets, verifyLogoHash, and catalog constants. */
function assertBuiltPackage(distDir: string, defaultBase: string): void {
  const root = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    version?: unknown;
  };
  const built = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof root.version !== "string" || built.version !== root.version) {
    throw new Error(
      `Built package version ${String(built.version)} does not match package.json version ${String(
        root.version,
      )}`,
    );
  }
  const indexSource = fs.readFileSync(path.join(distDir, "index.js"), "utf8");
  if (!indexSource.includes(defaultBase)) {
    throw new Error("Built index.js is missing the versioned jsDelivr logo base");
  }
  if (
    indexSource.includes("/main/data/") ||
    indexSource.includes("@main/") ||
    sourceContainsHostname(indexSource, "raw.githubusercontent.com")
  ) {
    throw new Error("Built index.js still falls back to a moving branch or a raw GitHub host");
  }
  if (
    indexSource.includes("GITHUB_ASSET_BASE_URL") ||
    indexSource.includes("DEFAULT_ASSET_BASE_URL")
  ) {
    throw new Error("Built index.js must not name the operator asset base");
  }
  if (indexSource.includes("package.json") || indexSource.includes("readFileSync")) {
    throw new Error("Built index.js must not read package.json at runtime");
  }
  const indexPath = path.join(distDir, "index.js");
  const require = createRequire(import.meta.url);
  delete require.cache[indexPath];
  const published = require(indexPath) as Record<string, unknown>;
  const keys = Object.keys(published).sort();
  const expected = [...PUBLISHED_EXPORTS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(`Unexpected package exports: ${keys.join(", ")}`);
  }
  if (typeof published.createAssets !== "function") {
    throw new Error("createAssets export is missing");
  }
  const dts = fs.readFileSync(path.join(distDir, "index.d.ts"), "utf8");
  if (!dts.includes("export interface CreateAssetsOptions")) {
    throw new Error("index.d.ts is missing CreateAssetsOptions");
  }
  if (!dts.includes("export interface Assets")) {
    throw new Error("index.d.ts is missing Assets");
  }
  const createAssetsType =
    "export declare function createAssets(options?: CreateAssetsOptions): Assets";
  if (!dts.includes(createAssetsType)) {
    throw new Error("index.d.ts is missing createAssets");
  }
  if (
    dts.includes("export declare function resolveAssetURL") ||
    dts.includes("export declare function getProviders") ||
    dts.includes("GITHUB_ASSET_BASE_URL") ||
    dts.includes("DEFAULT_ASSET_BASE_URL")
  ) {
    throw new Error("index.d.ts still exports a removed entry");
  }
  if (!dts.includes("export declare function verifyLogoHash")) {
    throw new Error("index.d.ts is missing verifyLogoHash");
  }
  if (!dts.includes("export declare function fetchLogo")) {
    throw new Error("index.d.ts is missing fetchLogo");
  }
  if (typeof published.verifyLogoHash !== "function") {
    throw new Error("verifyLogoHash export is missing");
  }
  if (typeof published.fetchLogo !== "function") {
    throw new Error("fetchLogo export is missing");
  }
  if (
    !dts.includes(`export declare const EIP712_DOMAIN_SALT: ${JSON.stringify(EIP712_DOMAIN_SALT)}`)
  ) {
    throw new Error("index.d.ts is missing EIP712_DOMAIN_SALT");
  }
  if (!dts.includes("export declare const PROVIDER_LISTING_TYPES:")) {
    throw new Error("index.d.ts is missing PROVIDER_LISTING_TYPES");
  }
  if (
    !dts.includes(
      `export declare const PROVIDER_LISTING_PRIMARY_TYPE: ${JSON.stringify(PROVIDER_LISTING_PRIMARY_TYPE)}`,
    )
  ) {
    throw new Error("index.d.ts is missing PROVIDER_LISTING_PRIMARY_TYPE");
  }
  if (dts.includes("export declare function providerListingDomain(")) {
    throw new Error("index.d.ts still exports providerListingDomain");
  }
  if (!dts.includes("export declare function providerListingTypedData<")) {
    throw new Error("index.d.ts is missing providerListingTypedData");
  }
  if (indexSource.includes("keccak256") || indexSource.includes("viem")) {
    throw new Error("Built index.js must not hash the domain salt or depend on viem");
  }
  const signaturesSource = fs.readFileSync(path.join(distDir, "signatures.js"), "utf8");
  const signaturesDts = fs.readFileSync(path.join(distDir, "signatures.d.ts"), "utf8");
  if (!signaturesSource.includes("function getProviderListingVerification")) {
    throw new Error("signatures.js is missing getProviderListingVerification");
  }
  if (!signaturesDts.includes("export declare function getProviderListingVerification(")) {
    throw new Error("signatures.d.ts is missing getProviderListingVerification");
  }
  if (
    signaturesSource.includes("keccak256") ||
    signaturesSource.includes("viem") ||
    signaturesSource.includes('require("./index')
  ) {
    throw new Error("signatures.js must not hash, depend on viem, or load the main entry");
  }
}

/**
 * The release tag is the package version. Published logoURLs are
 * relative to `data/`. The tagged commit must contain `data/<logoURL>`.
 */
function assertPublishedLogosExistUnderData(distDir: string): void {
  const missing: string[] = [];
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name === "package.json") continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object" || !("logoURL" in item)) continue;
        const logoURL = (item as { logoURL: unknown }).logoURL;
        if (typeof logoURL !== "string" || logoURL.length === 0) continue;
        count += 1;
        if (logoURL.includes("..") || path.isAbsolute(logoURL)) {
          missing.push(logoURL);
          continue;
        }
        if (!fs.existsSync(path.join(process.cwd(), "data", logoURL))) missing.push(logoURL);
      }
    }
  };
  walk(distDir);
  if (count === 0 || missing.length > 0) {
    const sample = missing.slice(0, 5).join(", ") || "(none published)";
    throw new Error(`Release tag is missing data/ files for published logoURLs: ${sample}`);
  }
}

/** Plain JS copy of src/eip712.ts. Values come from that module; this file does not hash. */
function eip712RuntimeJs(): string {
  return `const EIP712_DOMAIN_SALT = ${JSON.stringify(EIP712_DOMAIN_SALT)};
const PROVIDER_LISTING_PRIMARY_TYPE = ${JSON.stringify(PROVIDER_LISTING_PRIMARY_TYPE)};
const PROVIDER_LISTING_TYPES = ${JSON.stringify(PROVIDER_LISTING_TYPES)};
const LISTING_CHAIN_IDS = { "eip155:14": 14, "eip155:19": 19 };

function providerListingTypedData(options) {
  const chain = options && options.chain;
  if (!Object.hasOwn(LISTING_CHAIN_IDS, chain)) {
    throw new Error('Use "eip155:14" or "eip155:19". Got: ' + JSON.stringify(chain));
  }
  return {
    domain: {
      name: ${JSON.stringify(EIP712_DOMAIN_NAME)},
      version: ${JSON.stringify(EIP712_DOMAIN_VERSION)},
      chainId: LISTING_CHAIN_IDS[chain],
      salt: EIP712_DOMAIN_SALT,
    },
    types: PROVIDER_LISTING_TYPES,
    primaryType: PROVIDER_LISTING_PRIMARY_TYPE,
    message: options.message,
  };
}
`;
}

function eip712Declarations(): string {
  const fields = PROVIDER_LISTING_TYPES.ProviderListing.map((field) => {
    const name = JSON.stringify(field.name);
    const type = JSON.stringify(field.type);
    return `    { readonly name: ${name}; readonly type: ${type} },`;
  }).join("\n");
  const domainName = JSON.stringify(EIP712_DOMAIN_NAME);
  const domainVersion = JSON.stringify(EIP712_DOMAIN_VERSION);
  const salt = JSON.stringify(EIP712_DOMAIN_SALT);
  const primaryType = JSON.stringify(PROVIDER_LISTING_PRIMARY_TYPE);
  return `/** Precomputed keccak256 of the UTF-8 bytes of https://bifrostwallet.com. */
export declare const EIP712_DOMAIN_SALT: ${salt};

export declare const PROVIDER_LISTING_PRIMARY_TYPE: ${primaryType};

export declare const PROVIDER_LISTING_TYPES: {
  readonly ProviderListing: readonly [
${fields}
  ];
};

export interface ProviderListingMessage {
  name: string;
  description: string;
  websiteURL: string;
  logoHash: \`0x\${string}\`;
  identityAddress: \`0x\${string}\`;
  linksJson: string;
  acknowledgedResponsibilities: boolean;
  contentHash: \`0x\${string}\`;
}

/** Typed data for verifyTypedData. chain is "eip155:14" or "eip155:19". */
export declare function providerListingTypedData<T extends ProviderListingMessage>(options: {
  message: T;
  chain: "eip155:14" | "eip155:19";
}): {
  domain: {
    name: ${domainName};
    version: ${domainVersion};
    chainId: number;
    salt: typeof EIP712_DOMAIN_SALT;
  };
  types: typeof PROVIDER_LISTING_TYPES;
  primaryType: typeof PROVIDER_LISTING_PRIMARY_TYPE;
  message: T;
};
`;
}

function buildIndexJs(
  tokenChains: string[],
  contractChains: string[],
  defaultBase: string,
): string {
  const tokenRequires =
    tokenChains.length === 0
      ? ""
      : `${tokenChains.map((chain) => `  "${chain}": require("./tokens/${chain}.json"),`).join("\n")}\n`;
  const contractRequires =
    contractChains.length === 0
      ? ""
      : `${contractChains.map((chain) => `  "${chain}": require("./contracts/${chain}.json"),`).join("\n")}\n`;
  return `"use strict";
// @bifrostwallet/assets — generated file, do not edit.

const providersByChain = {
${PROVIDER_CHAINS.map((chain) => `  "${chain}": require("./providers/${chain}.json"),`).join("\n")}
};

const tokensByChain = {
${tokenRequires}};

const contractsByChain = {
${contractRequires}};

/** Hand-ordered browser chips. Not an all.json aggregate. */
const dappCategories = require("./dapps/categories.json");

const PROVIDER_CHAIN_IDS = Object.keys(providersByChain).map(chainPathToCaip2);
const TOKEN_CHAIN_IDS = Object.keys(tokensByChain).map(chainPathToCaip2);
const CONTRACT_CHAIN_IDS = Object.keys(contractsByChain).map(chainPathToCaip2);
const CONTRACT_CATEGORIES = ${JSON.stringify([...CONTRACT_CATEGORIES])};
const CONTRACT_CATEGORY_LABELS = ${JSON.stringify(CONTRACT_CATEGORY_LABELS)};
const DAPP_CATEGORIES = ${JSON.stringify([...DAPP_CATEGORIES])};
const DAPP_CATEGORY_LABELS = ${JSON.stringify(DAPP_CATEGORY_LABELS)};
const DEFAULT_LOGO_BASE_URL = ${JSON.stringify(defaultBase)};

${eip712RuntimeJs()}
function chainPathToCaip2(chainPath) {
  const i = String(chainPath).indexOf("-");
  return i === -1 ? String(chainPath) : String(chainPath).slice(0, i) + ":" + String(chainPath).slice(i + 1);
}

function normalizeChainId(chainId) {
  // Public API accepts CAIP-2 only (e.g. "eip155:14"). Repo paths use eip155-14.
  if (typeof chainId !== "string" || !chainId.includes(":")) {
    throw new Error(
      'Use a CAIP-2 chain id (e.g. "eip155:14"). Got: ' + JSON.stringify(chainId)
    );
  }
  return chainId.replace(":", "-");
}

function getProviders(chainId) {
  const providers = providersByChain[normalizeChainId(chainId)];
  if (!providers) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + PROVIDER_CHAIN_IDS.join(", ")
    );
  }
  return providers;
}

function getProvider(chainId, identityAddress) {
  const target = String(identityAddress).toLowerCase();
  return (
    getProviders(chainId).find(
      (provider) => provider.identityAddress.toLowerCase() === target
    ) ?? null
  );
}

function getListedProviders(chainId) {
  return getProviders(chainId).filter((provider) => provider.listed);
}

function getManagementGroupProviders(chainId) {
  return getProviders(chainId).filter((provider) => provider.managementGroup);
}

function findProviderByValidator(chainId, nodeId) {
  return (
    getProviders(chainId).find((provider) => provider.validators.includes(nodeId)) ??
    null
  );
}

function collectValidators(providers) {
  const list = [];
  for (const provider of providers) {
    const nodeIds = Array.isArray(provider.validators) ? provider.validators : [];
    for (const nodeId of nodeIds) {
      list.push({
        nodeId: nodeId,
        identityAddress: provider.identityAddress,
        name: provider.name,
        logoURL: provider.logoURL,
        logoHash: provider.logoHash,
      });
    }
  }
  return list;
}

const validatorsByChain = {};
const listedValidatorsByChain = {};
for (const chainPath of Object.keys(providersByChain)) {
  const providers = providersByChain[chainPath];
  validatorsByChain[chainPath] = collectValidators(providers);
  listedValidatorsByChain[chainPath] = collectValidators(
    providers.filter((provider) => provider.listed)
  );
}

function validatorsForChain(chainId, byChain) {
  const validators = byChain[normalizeChainId(chainId)];
  if (!validators) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + PROVIDER_CHAIN_IDS.join(", ")
    );
  }
  return validators;
}

function getValidators(chainId) {
  return validatorsForChain(chainId, validatorsByChain);
}

function getListedValidators(chainId) {
  return validatorsForChain(chainId, listedValidatorsByChain);
}

function getValidatorsByIdentity(chainId, identityAddress) {
  const target = String(identityAddress).toLowerCase();
  return getValidators(chainId).filter(
    (validator) => String(validator.identityAddress).toLowerCase() === target
  );
}

function getTokens(chainId) {
  const tokens = tokensByChain[normalizeChainId(chainId)];
  if (!tokens) {
    throw new Error(
      "Unknown token chain " + chainId + ". Available: " + TOKEN_CHAIN_IDS.join(", ")
    );
  }
  return tokens;
}

function getToken(chainId, address) {
  const tokens = getTokens(chainId);
  const target = String(address).toLowerCase();
  return (
    tokens.find(
      (token) => token.address && token.address.toLowerCase() === target
    ) ?? null
  );
}

function getXrplToken(issuer, currency) {
  const issuerKey = String(issuer);
  const currencyKey = String(currency);
  return (
    getTokens("xrpl:0").find(
      (token) => token.issuer === issuerKey && token.currency === currencyKey
    ) ?? null
  );
}

function getNativeToken(chainId) {
  return getTokens(chainId).find((token) => token.address === null) ?? null;
}

function contractsWithChain(chainPath, contracts) {
  const chain = chainPathToCaip2(chainPath);
  return contracts.map((contract) => ({ ...contract, chain }));
}

function getContracts(chainId) {
  if (chainId == null) {
    const all = [];
    for (const chain of Object.keys(contractsByChain).sort()) {
      all.push(...contractsWithChain(chain, contractsByChain[chain]));
    }
    return all;
  }
  const chainPath = normalizeChainId(chainId);
  const contracts = contractsByChain[chainPath];
  if (!contracts) {
    throw new Error(
      "Unknown contract chain " + chainId + ". Available: " + CONTRACT_CHAIN_IDS.join(", ")
    );
  }
  return contractsWithChain(chainPath, contracts);
}

function getContract(chainId, address) {
  const target = String(address).toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}

function getDappCategories() {
  return dappCategories;
}

function isHttpsUrl(value) {
  return /^https:\\/\\//i.test(String(value).trim());
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value).trim());
}

function toRelativeAssetPath(logoURL) {
  const trimmed = String(logoURL).trim();
  if (isHttpsUrl(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname;
      for (const marker of ["/static/", "/data/"]) {
        const idx = pathname.indexOf(marker);
        if (idx !== -1) {
          return pathname.slice(idx + marker.length).replace(/^\\//, "");
        }
      }
    } catch {
      // fall through
    }
    const match = trimmed.match(/((?:providers|dapps|tokens|contracts)\\/[^?#]+)/);
    return match ? match[1] : trimmed;
  }
  if (hasUrlScheme(trimmed)) {
    throw new Error("Asset URL must start with https://, got " + JSON.stringify(logoURL));
  }
  return trimmed.replace(/^\\//, "");
}

function normalizeAssetBase(baseURL) {
  const supplied = typeof baseURL === "string" ? baseURL.trim() : "";
  if (!isHttpsUrl(supplied)) {
    throw new Error("Asset base must start with https://, got " + JSON.stringify(baseURL));
  }
  return supplied.replace(/\\/?$/, "/");
}

function resolveAssetURL(logoURL, baseURL) {
  const base = normalizeAssetBase(baseURL);
  const relative = toRelativeAssetPath(logoURL);
  if (isHttpsUrl(relative)) {
    return relative;
  }
  return base + relative.replace(/^\\//, "");
}

function isRelativeAssetPath(value) {
  let assetPath = String(value).trim();
  if (assetPath.startsWith("/")) assetPath = assetPath.slice(1);
  return (
    assetPath.startsWith("providers/") ||
    assetPath.startsWith("dapps/") ||
    assetPath.startsWith("tokens/") ||
    assetPath.startsWith("contracts/")
  );
}

function verifyLogoHash(bytes, expectedHash) {
  return require("./verify-logo-hash.js").verifyLogoHash(bytes, expectedHash);
}

function fetchLogo(entry, options) {
  return require("./verify-logo-hash.js").fetchLogo(entry, options);
}

function createAssets(options) {
  let supplied;
  if (options === undefined || options === null) {
    supplied = undefined;
  } else if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Asset base must start with https://, got " + JSON.stringify(options));
  } else {
    supplied = options.baseURL;
  }
  const base =
    supplied === undefined || supplied === null
      ? DEFAULT_LOGO_BASE_URL
      : normalizeAssetBase(supplied);
  const cache = new WeakMap();

  function present(value) {
    if (typeof value === "string") {
      return isRelativeAssetPath(value) ? resolveAssetURL(value, base) : value;
    }
    if (Array.isArray(value)) {
      const cached = cache.get(value);
      if (cached) return cached;
      let changed = false;
      const next = value.map((item) => {
        const resolved = present(item);
        if (resolved !== item) changed = true;
        return resolved;
      });
      if (!changed) return value;
      cache.set(value, next);
      return next;
    }
    if (!value || typeof value !== "object") return value;
    const cached = cache.get(value);
    if (cached) return cached;
    let copy = null;
    for (const key of Object.keys(value)) {
      const field = value[key];
      let resolved = field;
      if (
        (key === "logoURL" && typeof field === "string") ||
        (typeof field === "string" && isRelativeAssetPath(field))
      ) {
        resolved = resolveAssetURL(field, base);
      } else if (field && typeof field === "object") {
        resolved = present(field);
      }
      if (resolved !== field) {
        if (!copy) copy = { ...value };
        copy[key] = resolved;
      }
    }
    if (!copy) return value;
    cache.set(value, copy);
    return copy;
  }

  return {
    getProviders: (chainId) => present(getProviders(chainId)),
    getProvider: (chainId, identityAddress) => present(getProvider(chainId, identityAddress)),
    getListedProviders: (chainId) => present(getListedProviders(chainId)),
    getManagementGroupProviders: (chainId) => present(getManagementGroupProviders(chainId)),
    findProviderByValidator: (chainId, nodeId) => present(findProviderByValidator(chainId, nodeId)),
    getValidators: (chainId) => present(getValidators(chainId)),
    getListedValidators: (chainId) => present(getListedValidators(chainId)),
    getValidatorsByIdentity: (chainId, identityAddress) =>
      present(getValidatorsByIdentity(chainId, identityAddress)),
    getTokens: (chainId) => present(getTokens(chainId)),
    getToken: (chainId, address) => present(getToken(chainId, address)),
    getXrplToken: (issuer, currency) => present(getXrplToken(issuer, currency)),
    getNativeToken: (chainId) => present(getNativeToken(chainId)),
    getContracts: (chainId) => present(getContracts(chainId)),
    getContract: (chainId, address) => present(getContract(chainId, address)),
    getDappCategories: () => present(getDappCategories()),
  };
}

module.exports = {
  PROVIDER_CHAIN_IDS,
  TOKEN_CHAIN_IDS,
  CONTRACT_CHAIN_IDS,
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  DAPP_CATEGORIES,
  DAPP_CATEGORY_LABELS,
  EIP712_DOMAIN_SALT,
  PROVIDER_LISTING_PRIMARY_TYPE,
  PROVIDER_LISTING_TYPES,
  providerListingTypedData,
  createAssets,
  fetchLogo,
  verifyLogoHash,
};
`;
}

const INDEX_DTS = `// @bifrostwallet/assets — generated file, do not edit.

export interface ProviderInfo {
  name: string;
  description: string;
  websiteURL: string;
  links: {
    github?: string;
    x?: string;
    discord?: string;
    telegram?: string;
    youtube?: string;
    reddit?: string;
    linkedin?: string;
    tiktok?: string;
  };
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  /** SHA-256 of the logo file, covered by provider signatures */
  logoHash: string;
  identityAddress: string;
  delegationAddress: string;
  signingPolicyAddress: string;
  submitAddress: string;
  submitSignaturesAddress: string;
  publicKey: string;
  /** Avalanche-style NodeIDs of the provider's validators */
  validators: string[];
  /** Curator-granted listing flag for Bifrost Wallet UIs */
  listed: boolean;
  /** Flare FTSO Management Group membership (synced on-chain) */
  managementGroup: boolean;
  /** Optional domain linkage, refreshed nightly from websiteURL */
  domainLinked: boolean;
  /** Same brand present on both Flare and Songbird in this catalog (curator-reviewed) */
  dualNetwork: boolean;
  /** Earliest known provider activity on this network (write-once, curator-managed) */
  firstTransaction?: {
    hash: string;
    blockNumber: number;
    /** ISO 8601 UTC */
    timestamp: string;
  };
}

export interface EvmToken {
  name: string;
  symbol: string;
  decimals: number;
  /** Lowercase 0x… for contracts; null for the native gas token. */
  address: string | null;
  /** Always present — string CoinGecko id, or null when unmapped / unpriced */
  coingeckoId: string | null;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  logoHash: string;
}

export interface XrplToken {
  name: string;
  symbol: string;
  /** Classic r-address, exact case. */
  issuer: string;
  /** On-ledger currency: 3-character exact case, or 40-hex uppercase. */
  currency: string;
  /** Always present — string CoinGecko id, or null when unmapped / unpriced */
  coingeckoId: string | null;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  logoHash: string;
}

/** CAIP-2 chain id, e.g. "eip155:14" or "eip155:19" */
export type ChainId = string;

export declare const PROVIDER_CHAIN_IDS: string[];
export declare const TOKEN_CHAIN_IDS: string[];
export declare const CONTRACT_CHAIN_IDS: string[];

export type ContractCategory =
%%CONTRACT_CATEGORY_UNION%%

/** Product-approved category ids, in display order. */
export declare const CONTRACT_CATEGORIES: readonly ContractCategory[];
/** Display names. Use these instead of hardcoding category strings. */
export declare const CONTRACT_CATEGORY_LABELS: Record<ContractCategory, string>;

export type DappCategory =
%%DAPP_CATEGORY_UNION%%

/** Browser chip ids, in chip order. Separate from contract categories. */
export declare const DAPP_CATEGORIES: readonly DappCategory[];
/** Display names for those chips. marketplaces is NFT marketplaces only. */
export declare const DAPP_CATEGORY_LABELS: Record<DappCategory, string>;

export interface DappCategoryGroup {
  id: DappCategory;
  label: string;
  /** Hand-ordered slugs. A slug may appear in more than one group. */
  dapps: string[];
}

export interface ContractInfo {
  /** Lowercase 0x address */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14" */
  chain: string;
  /**
   * Project slug. Omitted only when the contract has its own logo and no project.
   * Resolved at package build. Consumers do not look up the project folder.
   */
  project?: string;
  /** Display name from that project. Present when project is set. */
  projectName?: string;
  contractName: string;
  category: ContractCategory;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  /** SHA-256 of that logo file, resolved at package build. */
  logoHash: string;
}

export interface ValidatorInfo {
  /** Avalanche-style NodeID */
  nodeId: string;
  /** Owning provider identity address */
  identityAddress: string;
  /** Owning provider display name */
  name: string;
  /** Absolute logo URL of the operating provider, for the baseURL passed to createAssets. */
  logoURL: string;
  /** SHA-256 of that logo. Same digest as the operating provider's signed logoHash. */
  logoHash: string;
}

export interface CreateAssetsOptions {
  /**
   * Public URL of the directory you uploaded (the contents of data/).
   * Optional. Omit it to use jsDelivr for this package version.
   * Example: https://assets.example.com/
   */
  baseURL?: string;
}

/** Any curated catalog entry. Tokens, providers, contracts, and dapps use this shape. */
export interface LogoEntry {
  logoURL: string;
  logoHash: string;
}

export interface FetchLogoOptions {
  /** Defaults to global fetch. Tests pass a substitute. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Fetch entry.logoURL and return the bytes when they match entry.logoHash.
 * Throws if the request fails or the hash does not match.
 */
export declare function fetchLogo(
  entry: LogoEntry,
  options?: FetchLogoOptions,
): Promise<Uint8Array>;

/**
 * True when SHA-256 of the decoded logo bytes equals expectedHash.
 * expectedHash is 64 lowercase hex characters with no 0x prefix (catalog logoHash).
 * Use this when the bytes are already on disk. fetchLogo calls it after a download.
 */
export declare function verifyLogoHash(
  bytes: ArrayBuffer | Uint8Array,
  expectedHash: string,
): boolean;

/** Catalog getters. logoURL values are absolute for baseURL, or for this version's jsDelivr URL when baseURL is omitted. */
export interface Assets {
  /** All curated providers for a chain (throws on unknown chain) */
  getProviders(chainId: ChainId): ProviderInfo[];
  /** A single provider by identity address (case-insensitive), or null */
  getProvider(chainId: ChainId, identityAddress: string): ProviderInfo | null;
  /** Providers listed in Bifrost Wallet UIs */
  getListedProviders(chainId: ChainId): ProviderInfo[];
  /** Providers that are current FTSO Management Group members */
  getManagementGroupProviders(chainId: ChainId): ProviderInfo[];
  /** The provider operating a validator NodeID, or null */
  findProviderByValidator(chainId: ChainId, nodeId: string): ProviderInfo | null;
  /**
   * Every validator on a chain, in getProviders order.
   * Validators of one provider stay together, in that provider's validators order.
   * Throws on an unknown chain.
   */
  getValidators(chainId: ChainId): ValidatorInfo[];
  /** Validators of providers with listed: true, same order as getValidators. */
  getListedValidators(chainId: ChainId): ValidatorInfo[];
  /**
   * Validators for one provider identity. The address match is case-insensitive.
   * Returns an empty array when that identity is absent. Throws on an unknown chain.
   */
  getValidatorsByIdentity(chainId: ChainId, identityAddress: string): ValidatorInfo[];
  /**
   * All curated tokens for a chain (throws on unknown chain).
   * \`xrpl:0\` returns XrplToken. Every other chain returns EvmToken.
   */
  getTokens(chainId: "xrpl:0"): XrplToken[];
  getTokens(chainId: ChainId): EvmToken[];
  /** One EVM token by address (case-insensitive), or null. */
  getToken(chainId: ChainId, address: string): EvmToken | null;
  /**
   * One XRPL mainnet issued token by exact-case issuer and currency, or null.
   * There is no combined address key.
   */
  getXrplToken(issuer: string, currency: string): XrplToken | null;
  /** Native gas token entry for a chain, or null */
  getNativeToken(chainId: ChainId): EvmToken | null;
  /**
   * Curated contracts. Omit chainId for every chain.
   * Throws on an unknown CAIP-2 id.
   * Each record already includes project, projectName, logoURL, and logoHash.
   */
  getContracts(chainId?: ChainId): ContractInfo[];
  /** One contract by address (case-insensitive), or null */
  getContract(chainId: ChainId, address: string): ContractInfo | null;
  /**
   * Browser chips from data/dapps/categories.json, in curated order.
   * This is not a dapp all.json.
   */
  getDappCategories(): DappCategoryGroup[];
}

/** Catalog getters with logo URLs joined to baseURL. baseURL is optional. */
export declare function createAssets(options?: CreateAssetsOptions): Assets;
`;

const packageDistLockDir = path.join(
  os.tmpdir(),
  `bifrost-assets-dist-${createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16)}.lock`,
);

let packageDistLockDepth = 0;

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquirePackageDistLock(): void {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      fs.mkdirSync(packageDistLockDir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - fs.statSync(packageDistLockDir).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > 180_000) {
        fs.rmSync(packageDistLockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the package build lock");
      }
      sleepMs(50);
    }
  }
}

function releasePackageDistLock(): void {
  fs.rmSync(packageDistLockDir, { recursive: true, force: true });
}

/** Hold dist/ until the returned function runs. Re-entrant in this process. */
export function holdPackageDist(): () => void {
  if (packageDistLockDepth === 0) acquirePackageDistLock();
  packageDistLockDepth += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    packageDistLockDepth -= 1;
    if (packageDistLockDepth === 0) releasePackageDistLock();
  };
}

function withPackageDist(build: () => void): void {
  const release = holdPackageDist();
  try {
    build();
  } finally {
    release();
  }
}

function buildPackage(): void {
  withPackageDist(buildPackageUnlocked);
}

function buildPackageUnlocked(): void {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const packageVersion = rootPackage.version;
  if (typeof packageVersion !== "string") {
    throw new Error("package.json version is required");
  }
  const releaseTag = releaseTagForVersion(packageVersion);
  if (typeof rootPackage.repository !== "string") {
    throw new Error("package.json repository is required");
  }
  const defaultBase = jsDelivrDataBaseFromRepository(rootPackage.repository, releaseTag);
  if (!defaultBase) {
    throw new Error(
      "Could not derive the jsDelivr logo base from package.json repository (expected a GitHub URL)",
    );
  }
  assertJsDelivrReleaseBase(defaultBase, packageVersion);

  const distDir = path.join(process.cwd(), "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, "providers"), { recursive: true });

  for (const chain of PROVIDER_CHAINS) {
    const providers = loadProviders(chain);
    const outPath = path.join(distDir, "providers", `${chain}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(providers, null, 2)}\n`);
    console.info(`📦 providers/${chain}.json (${providers.length} providers)`);
  }

  const tokenChainIds = listTokenChainPaths();
  if (tokenChainIds.length > 0) {
    fs.mkdirSync(path.join(distDir, "tokens"), { recursive: true });
    for (const chain of tokenChainIds) {
      const tokens = loadTokens(chain);
      const outPath = path.join(distDir, "tokens", `${chain}.json`);
      fs.writeFileSync(outPath, `${JSON.stringify(tokens, null, 2)}\n`);
      console.info(`📦 tokens/${chain}.json (${tokens.length} tokens)`);
    }
  }

  const contractChainIds = listContractChainPaths();
  if (contractChainIds.length > 0) {
    const contractErrors = validateContractCatalog();
    if (contractErrors.length > 0) {
      throw new Error(
        `Refusing to publish an invalid contract catalog:\n${contractErrors
          .map((error) => `  ${error}`)
          .join("\n")}`,
      );
    }
    fs.mkdirSync(path.join(distDir, "contracts"), { recursive: true });
    for (const chain of contractChainIds) {
      const contracts = loadContracts(chain);
      const outPath = path.join(distDir, "contracts", `${chain}.json`);
      fs.writeFileSync(outPath, `${JSON.stringify(contracts, null, 2)}\n`);
      console.info(`📦 contracts/${chain}.json (${contracts.length} contracts)`);
    }
  }

  const categoriesSrc = path.join(process.cwd(), "data", "dapps", "categories.json");
  if (!fs.existsSync(categoriesSrc)) {
    throw new Error("data/dapps/categories.json missing");
  }
  const categoriesBody = fs.readFileSync(categoriesSrc);
  fs.mkdirSync(path.join(distDir, "dapps"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "dapps", "categories.json"), categoriesBody);
  console.info("📦 dapps/categories.json");

  fs.writeFileSync(
    path.join(distDir, "index.js"),
    buildIndexJs(tokenChainIds, contractChainIds, defaultBase),
  );
  fs.writeFileSync(
    path.join(distDir, "verify-logo-hash.js"),
    `"use strict";\n${VERIFY_LOGO_HASH_JS}\nmodule.exports = { verifyLogoHash, fetchLogo };\n`,
  );
  const fetchLogosPath = path.join(distDir, "fetch-logos.js");
  fs.writeFileSync(fetchLogosPath, fetchLogosSource(defaultBase));
  fs.chmodSync(fetchLogosPath, 0o755);
  const categoryUnion = CONTRACT_CATEGORIES.map(
    (category) => `  | ${JSON.stringify(category)}`,
  ).join("\n");
  const dappCategoryUnion = DAPP_CATEGORIES.map(
    (category) => `  | ${JSON.stringify(category)}`,
  ).join("\n");
  const indexDts = INDEX_DTS.replace("%%CONTRACT_CATEGORY_UNION%%", `${categoryUnion};`).replace(
    "%%DAPP_CATEGORY_UNION%%",
    `${dappCategoryUnion};`,
  );
  fs.writeFileSync(path.join(distDir, "index.d.ts"), `${indexDts}\n${eip712Declarations()}`);
  const signatureCount = writeSignatureSidecar(distDir);
  const indexSource = fs.readFileSync(path.join(distDir, "index.js"), "utf8");
  if (indexSource.includes('require("./signatures')) {
    throw new Error("index.js must not load the signatures sidecar");
  }

  const manifest = {
    name: "@bifrostwallet/assets",
    version: rootPackage.version,
    description:
      rootPackage.description ??
      "Curated catalog of FTSO providers, validators, tokens, contracts and dapps for Bifrost Wallet.",
    repository: rootPackage.repository,
    author: rootPackage.author,
    license: "MIT",
    main: "index.js",
    types: "index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./signatures": {
        types: "./signatures.d.ts",
        default: "./signatures.js",
      },
    },
    bin: {
      "fetch-logos": "./fetch-logos.js",
    },
    sideEffects: false,
    dependencies: {},
  };
  fs.writeFileSync(path.join(distDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const readmePath = path.join(process.cwd(), "README.md");
  if (!fs.existsSync(readmePath)) {
    throw new Error("README.md missing — required for the published npm README");
  }
  const publishedReadmePath = path.join(distDir, "README.md");
  fs.copyFileSync(readmePath, publishedReadmePath);
  if (!fs.readFileSync(publishedReadmePath).equals(fs.readFileSync(readmePath))) {
    throw new Error("dist/README.md does not match the repository README.md");
  }

  const written = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf8"));
  const dependencyCount = Object.keys(written.dependencies ?? {}).length;
  if (dependencyCount > 0 || written.devDependencies || written.peerDependencies) {
    throw new Error("dist/package.json must not declare any dependencies");
  }

  const logoCount = assertCatalogLogoHashes(distDir);
  assertNoBundledLogos(distDir);
  assertBuiltPackage(distDir, defaultBase);
  assertPublishedLogosExistUnderData(distDir);
  console.info(`   ${logoCount} catalog logo hash(es) checked`);

  console.info("\n✅ Built zero-dependency package in dist/");
  console.info("   published JSON keeps relative logoURL; createAssets resolves it");
  console.info(`   ${signatureCount} provider signature payload(s) in ./signatures`);
  console.info("   Publish with: npm publish ./dist");
}

if (isMain(import.meta.url)) {
  try {
    buildPackage();
  } catch (error) {
    console.error("❌ Package build failed:", error);
    process.exitCode = 1;
  }
}

export default buildPackage;
