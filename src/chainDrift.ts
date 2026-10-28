import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "./config.js";
import { rebuildProvidersAllJson, sortProviderInfo, writeFormattedJson } from "./convert.js";
import { fetchEntityData } from "./onchain.js";
import { findProviderDirs } from "./verify.js";

/** Chain facts the nightly job may rewrite without a new provider signature. */
export const CHAIN_OBSERVED_FIELDS = [
  "delegationAddress",
  "signingPolicyAddress",
  "submitAddress",
  "submitSignaturesAddress",
  "publicKey",
  "validators",
] as const;

export type ChainObservedField = (typeof CHAIN_OBSERVED_FIELDS)[number];

export interface ChainFieldChange {
  field: ChainObservedField;
  catalog: string;
  chain: string;
}

export interface ProviderChainDrift {
  chainPath: string;
  identityAddress: string;
  name: string;
  infoPath: string;
  changes: ChainFieldChange[];
  observed: Partial<ProviderInfo>;
}

function fieldText(field: ChainObservedField, info: Partial<ProviderInfo>): string | undefined {
  if (field === "validators") {
    if (!info.validators) return undefined;
    return JSON.stringify([...info.validators].sort());
  }
  const value = info[field];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.toLowerCase();
}

/** Compare catalog info.json with a chain read. Missing chain fields are skipped. */
export function diffProviderChainFields(
  catalog: ProviderInfo,
  observed: Partial<ProviderInfo>,
): ChainFieldChange[] {
  const changes: ChainFieldChange[] = [];
  for (const field of CHAIN_OBSERVED_FIELDS) {
    const chain = fieldText(field, observed);
    if (chain === undefined) continue;
    const current = fieldText(field, catalog) ?? "";
    if (current === chain) continue;
    changes.push({ field, catalog: current, chain });
  }
  return changes;
}

function networkForChainPath(chainPath: string) {
  return Object.values(BLOCKCHAIN_NETWORKS).find(
    (network) => network.path === chainPath && network.entityManager.length > 0,
  );
}

async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current] as T);
    }
  });
  await Promise.all(runners);
}

function applyObservedField(
  info: ProviderInfo,
  drift: ProviderChainDrift,
  field: ChainObservedField,
) {
  if (field === "validators") {
    info.validators = [...(drift.observed.validators ?? [])].sort();
    return;
  }
  const value = drift.observed[field];
  if (typeof value !== "string") return;
  info[field] = value.toLowerCase();
}

/** Read every provider and report chain fields that differ from EntityManager. */
export async function collectChainDrift(): Promise<ProviderChainDrift[]> {
  const drifts: ProviderChainDrift[] = [];

  await mapPool(findProviderDirs(), 4, async (providerDir) => {
    const infoPath = path.join(providerDir, "info.json");
    const catalog = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
    const chainPath = path.basename(path.dirname(providerDir));
    const network = networkForChainPath(chainPath);
    if (!network) return;

    let observed: Partial<ProviderInfo>;
    try {
      observed = await fetchEntityData(catalog.identityAddress, network);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠️ ${catalog.name} (${catalog.identityAddress}): chain read failed (${message})`,
      );
      return;
    }

    const changes = diffProviderChainFields(catalog, observed);
    if (changes.length === 0) return;
    drifts.push({
      chainPath,
      identityAddress: catalog.identityAddress,
      name: catalog.name,
      infoPath,
      changes,
      observed,
    });
  });

  drifts.sort((a, b) => a.identityAddress.localeCompare(b.identityAddress));
  return drifts;
}

/** Write drifted chain fields into info.json and rebuild affected all.json files. */
export function applyChainDrift(drifts: ProviderChainDrift[]): number {
  const chainsTouched = new Set<string>();
  let updated = 0;

  for (const drift of drifts) {
    if (!fs.existsSync(drift.infoPath)) continue;
    const info = JSON.parse(fs.readFileSync(drift.infoPath, "utf8")) as ProviderInfo;
    for (const change of drift.changes) {
      applyObservedField(info, drift, change.field);
    }
    writeFormattedJson(drift.infoPath, sortProviderInfo(info));
    chainsTouched.add(drift.chainPath);
    updated += 1;
  }

  for (const chainPath of chainsTouched) {
    rebuildProvidersAllJson(chainPath);
  }

  return updated;
}

export function formatChainDriftSummary(drifts: ProviderChainDrift[]): string {
  if (drifts.length === 0) {
    return "No provider chain fields differ from EntityManager.\n";
  }

  const lines = [
    "Chain drift — EntityManager differs from info.json for unsigned fields",
    "(delegation, submit, signing policy, public key, validators).",
    "",
    "Merging applies the chain values. Signatures stay valid because these fields are unsigned.",
    "",
  ];

  for (const drift of drifts) {
    lines.push(`- **${drift.name}** (\`${drift.identityAddress}\`, ${drift.chainPath})`);
    for (const change of drift.changes) {
      const from = change.catalog || "(empty)";
      lines.push(`  - \`${change.field}\`: \`${from}\` → \`${change.chain}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}
