import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import {
  rebuildProvidersAllJson,
  sortProviderInfo,
  toRelativePath,
  writeFormattedJson,
} from "../convert.js";
import { isMain } from "../isMain.js";

// Curator-reviewed dualNetwork sync: a provider is dualNetwork when the same
// brand appears on both Flare (eip155-14) and Songbird (eip155-19) in this
// catalog.
//
// Strong signals (cryptographically or on-chain bound; auto-set true):
//   1. same identityAddress on both chains (signature-verified at intake)
//   2. same delegationAddress on both chains (on-chain registration)
//   3. same websiteURL domain with domainLinked=true on BOTH chains
//      (proven control of the same domain via .well-known)
// Weak signals (self-declared free text a copycat submission could spoof;
// reported for curator confirmation, never written automatically):
//   4. same websiteURL domain without mutual domain linkage
//   5. same social link URL (e.g. the same X handle)
//   6. same normalized name
//   7. same normalized description (long-form only, to avoid boilerplate hits)
//
// Strong matches are written true and unmatched providers are written false.
// Weak-only matches always keep their current value: entries already true were
// curator-approved when committed, and entries still false are printed as
// candidates for the curator to confirm (and set manually if legitimate). Run
// with --dry-run to preview. Chains other than Flare/Songbird are forced to
// false.
//
// Usage:
//   ./yarn sync:dual-network
//   ./yarn sync:dual-network --dry-run

const FLARE_PATH = "eip155-14";
const SONGBIRD_PATH = "eip155-19";

/** Generic descriptions ("FTSO data provider") are too short to identify a brand. */
const MIN_DESCRIPTION_MATCH_LENGTH = 40;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function websiteDomain(websiteURL: string): string | null {
  try {
    const host = new URL(websiteURL).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function normalizeLinkURL(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

interface ProviderFile {
  infoPath: string;
  info: ProviderInfo;
}

function loadChainProviders(chainPath: string): ProviderFile[] {
  const chainDir = path.join(process.cwd(), "data", "providers", chainPath);
  if (!fs.existsSync(chainDir)) return [];

  const providers: ProviderFile[] = [];
  for (const entry of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(chainDir, entry.name, "info.json");
    if (!fs.existsSync(infoPath)) continue;
    providers.push({
      infoPath,
      info: JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo,
    });
  }
  return providers;
}

interface BrandKey {
  key: string;
  label: string;
}

/**
 * Signals bound to keys or proven domain control; safe to auto-set from.
 * The linked-domain key only exists when the entry itself is domainLinked, so
 * a cross-chain hit requires BOTH sides to have proven the same domain.
 */
export function strongBrandKeys(info: ProviderInfo): BrandKey[] {
  const keys: BrandKey[] = [
    { key: `id:${info.identityAddress.toLowerCase()}`, label: "identityAddress" },
  ];

  const delegation = info.delegationAddress.toLowerCase();
  if (delegation) keys.push({ key: `del:${delegation}`, label: "delegationAddress" });

  const domain = websiteDomain(info.websiteURL);
  if (domain && info.domainLinked) {
    keys.push({ key: `linked:${domain}`, label: "domainLinked website domain" });
  }

  return keys;
}

/** Self-declared free text a copycat submission could spoof; report-only. */
export function weakBrandKeys(info: ProviderInfo): BrandKey[] {
  const keys: BrandKey[] = [];

  const domain = websiteDomain(info.websiteURL);
  if (domain) keys.push({ key: `domain:${domain}`, label: "website domain (unproven)" });

  for (const [platform, url] of Object.entries(info.links ?? {})) {
    if (typeof url === "string" && url) {
      keys.push({ key: `link:${normalizeLinkURL(url)}`, label: `${platform} link` });
    }
  }

  const name = normalizeText(info.name);
  if (name) keys.push({ key: `name:${name}`, label: "name" });

  const description = normalizeText(info.description);
  if (description.length >= MIN_DESCRIPTION_MATCH_LENGTH) {
    keys.push({ key: `desc:${description}`, label: "description" });
  }

  return keys;
}

interface DualNetworkMatches {
  /** identity → matched signal; written as dualNetwork=true */
  strong: Map<string, string>;
  /** identity → matched signal; reported for curator confirmation only */
  weakOnly: Map<string, string>;
}

/** Identity addresses on `chain` whose brand also exists on `other`. */
function matchDualNetwork(chain: ProviderFile[], other: ProviderFile[]): DualNetworkMatches {
  const otherStrong = new Set<string>();
  const otherWeak = new Set<string>();
  for (const provider of other) {
    for (const { key } of strongBrandKeys(provider.info)) otherStrong.add(key);
    for (const { key } of weakBrandKeys(provider.info)) otherWeak.add(key);
  }

  const strong = new Map<string, string>();
  const weakOnly = new Map<string, string>();
  for (const provider of chain) {
    const identity = provider.info.identityAddress.toLowerCase();
    const strongHit = strongBrandKeys(provider.info).find(({ key }) => otherStrong.has(key));
    if (strongHit) {
      strong.set(identity, strongHit.label);
      continue;
    }
    const weakHit = weakBrandKeys(provider.info).find(({ key }) => otherWeak.has(key));
    if (weakHit) weakOnly.set(identity, weakHit.label);
  }
  return { strong, weakOnly };
}

export interface DualNetworkSyncResult {
  matchedBrands: number;
  updated: number;
  needsReview: number;
}

/** Writes dualNetwork onto every provider info.json and rebuilds all.json. */
export function syncDualNetwork(options: { dryRun?: boolean } = {}): DualNetworkSyncResult {
  const dryRun = options.dryRun ?? false;

  const flare = loadChainProviders(FLARE_PATH);
  const songbird = loadChainProviders(SONGBIRD_PATH);
  const emptyMatches: DualNetworkMatches = { strong: new Map(), weakOnly: new Map() };
  const matchesByChain = new Map<string, DualNetworkMatches>([
    [FLARE_PATH, matchDualNetwork(flare, songbird)],
    [SONGBIRD_PATH, matchDualNetwork(songbird, flare)],
  ]);

  const providersDir = path.join(process.cwd(), "data", "providers");
  let updated = 0;
  let needsReview = 0;

  for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const matches = matchesByChain.get(chain.name) ?? emptyMatches;
    let chainChanged = false;

    let providers: ProviderFile[];
    if (chain.name === FLARE_PATH) {
      providers = flare;
    } else if (chain.name === SONGBIRD_PATH) {
      providers = songbird;
    } else {
      providers = loadChainProviders(chain.name);
    }

    for (const provider of providers) {
      const identity = provider.info.identityAddress.toLowerCase();
      const relativePath = toRelativePath(provider.infoPath);

      const weakSignal = matches.weakOnly.get(identity);
      if (weakSignal !== undefined) {
        // Spoofable signal: never auto-set. Entries already true were
        // curator-approved when committed; only surface still-false entries
        // as candidates for manual confirmation (possible copycat).
        if (provider.info.dualNetwork === false) {
          needsReview++;
          console.info(
            `⚠️  ${provider.info.name}: weak match via ${weakSignal}, keeping dualNetwork=false — confirm manually (${relativePath})`,
          );
        }
        continue;
      }

      const strongSignal = matches.strong.get(identity);
      const isDual = strongSignal !== undefined;
      if (provider.info.dualNetwork === isDual) continue;

      console.info(
        `${isDual ? "➕" : "➖"} ${provider.info.name}: dualNetwork=${isDual}${strongSignal ? ` (via ${strongSignal})` : ""} (${relativePath})`,
      );
      updated++;

      if (!dryRun) {
        provider.info.dualNetwork = isDual;
        writeFormattedJson(provider.infoPath, sortProviderInfo(provider.info));
        chainChanged = true;
      }
    }

    if (chainChanged) {
      rebuildProvidersAllJson(chain.name);
    }
  }

  const matchedBrands =
    (matchesByChain.get(FLARE_PATH)?.strong.size ?? 0) +
    (matchesByChain.get(SONGBIRD_PATH)?.strong.size ?? 0);
  console.info(
    `\n${dryRun ? "🔍 Dry run" : "✅ Sync complete"}: ${matchedBrands} strong dual-network entr${matchedBrands === 1 ? "y" : "ies"}, ${updated} provider(s) ${dryRun ? "would change" : "updated"}, ${needsReview} weak match(es) need curator review`,
  );

  return { matchedBrands, updated, needsReview };
}

if (isMain(import.meta.url)) {
  try {
    syncDualNetwork({ dryRun: process.argv.includes("--dry-run") });
  } catch (error) {
    console.error("❌ Dual-network sync failed:", error);
    process.exitCode = 1;
  }
}
