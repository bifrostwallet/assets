import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, toRelativePath } from "../convert.js";
import { isMain } from "../isMain.js";

// Write-once firstTransaction scan (Blockscout Etherscan-compatible API).
//
// Per provider on Flare/Songbird, the earliest known activity is:
//   - FTSOv1 era: the delegation address's first successful outgoing
//     transaction, when it predates the network's EntityManager (FTSOv1 price
//     submissions came from the delegation address; no FSP registration
//     existed yet)
//   - FTSOv2 era: otherwise, the identity address's first successful outgoing
//     transaction to the EntityManager (FSP registration)
//
// The cutover block is the creation block of the FIRST EntityManager deployed
// on each network (nothing could register for FSP before it existed).
// Providers with firstTransaction already set are skipped (write-once); use
// --force to rescan. Run with --dry-run to preview without writing.
//
// Usage:
//   ./yarn scan:first-transaction [--dry-run] [--force]

const REQUEST_DELAY_MS = 250;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/**
 * FTSOv1 → FTSOv2 cutover per network path: the creation block of the original
 * EntityManager contract (BLOCKCHAIN_NETWORKS[].entityManager). Hardcoded so
 * the boundary stays fixed even if Flare redeploys the EntityManager. Found
 * via the explorer contract-creation lookup, e.g.:
 *   https://flare-explorer.flare.network/api?module=contract
 *     &action=getcontractcreation
 *     &contractaddresses=0x134b3311c6bded895556807a30c7f047d99dfdc2
 */
const FTSO_V2_CUTOVER_BLOCKS: Record<string, number> = {
  "eip155-14": 29548985, // Flare EntityManager 0x134b3311c6bded895556807a30c7f047d99dfdc2
  "eip155-19": 58653803, // Songbird EntityManager 0x46c417d0760198e94fee455ce0e223262a3d0049
};

export interface ExplorerTx {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  isError?: string;
}

export type FirstTransaction = NonNullable<ProviderInfo["firstTransaction"]>;

export function toFirstTransaction(tx: ExplorerTx): FirstTransaction {
  return {
    hash: tx.hash,
    blockNumber: Number(tx.blockNumber),
    timestamp: new Date(Number(tx.timeStamp) * 1000).toISOString(),
  };
}

/**
 * First successful transaction sent from `from` (optionally restricted to
 * recipient `to`) within an ascending transaction list.
 */
export function firstOutgoing(
  txs: ExplorerTx[],
  from: string,
  to?: string,
): ExplorerTx | undefined {
  const sender = from.toLowerCase();
  const recipient = to?.toLowerCase();
  return txs.find(
    (tx) =>
      tx.from?.toLowerCase() === sender &&
      tx.isError !== "1" &&
      (recipient === undefined || tx.to?.toLowerCase() === recipient),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExplorerResponse {
  status: string;
  message: string;
  result: unknown;
}

async function explorerRequest(explorer: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL("api", explorer);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  await sleep(REQUEST_DELAY_MS);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Explorer request failed (${response.status}): ${url.pathname}`);
  }
  const body = (await response.json()) as ExplorerResponse;
  if (body.status !== "1" && body.message !== "No transactions found") {
    throw new Error(`Explorer error: ${body.message}`);
  }
  return body.result;
}

async function fetchTxPage(explorer: string, address: string, page: number): Promise<ExplorerTx[]> {
  const result = await explorerRequest(explorer, {
    module: "account",
    action: "txlist",
    address,
    sort: "asc",
    page: String(page),
    offset: String(PAGE_SIZE),
  });
  return Array.isArray(result) ? (result as ExplorerTx[]) : [];
}

/** Paginates ascending until the first matching outgoing transaction. */
async function findFirstOutgoing(
  explorer: string,
  from: string,
  to?: string,
): Promise<ExplorerTx | undefined> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const txs = await fetchTxPage(explorer, from, page);
    const match = firstOutgoing(txs, from, to);
    if (match) return match;
    if (txs.length < PAGE_SIZE) return undefined;
  }
  console.warn(`  ⚠️ Gave up after ${MAX_PAGES * PAGE_SIZE} transactions for ${from}`);
  return undefined;
}

interface ScanOptions {
  dryRun?: boolean;
  force?: boolean;
}

export interface FirstTransactionScanResult {
  scanned: number;
  updated: number;
  unresolved: number;
}

export async function scanFirstTransactions(
  options: ScanOptions = {},
): Promise<FirstTransactionScanResult> {
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const result: FirstTransactionScanResult = { scanned: 0, updated: 0, unresolved: 0 };

  const networks = Object.values(BLOCKCHAIN_NETWORKS).filter((n) => n.entityManager !== "");
  for (const network of networks) {
    const chainDir = path.join(process.cwd(), "data", "providers", network.path);
    if (!fs.existsSync(chainDir)) continue;

    const cutoverBlock = FTSO_V2_CUTOVER_BLOCKS[network.path];
    if (!cutoverBlock) {
      throw new Error(`No FTSOv2 cutover block configured for ${network.name}`);
    }
    console.info(`${network.name}: FTSOv2 cutover at block ${cutoverBlock}`);
    let chainChanged = false;

    for (const entry of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const infoPath = path.join(chainDir, entry.name, "info.json");
      if (!fs.existsSync(infoPath)) continue;

      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
      if (info.firstTransaction && !force) continue;
      result.scanned++;

      let chosen: { tx: ExplorerTx; source: string } | undefined;
      if (info.delegationAddress) {
        const tx = await findFirstOutgoing(network.explorer, info.delegationAddress);
        if (tx && Number(tx.blockNumber) < cutoverBlock) {
          chosen = { tx, source: "FTSOv1 delegation address" };
        }
      }
      if (!chosen) {
        const tx = await findFirstOutgoing(
          network.explorer,
          info.identityAddress,
          network.entityManager,
        );
        if (tx) chosen = { tx, source: "FTSOv2 EntityManager registration" };
      }

      if (!chosen) {
        result.unresolved++;
        console.warn(`⚠️  ${info.name}: no first transaction found (${toRelativePath(infoPath)})`);
        continue;
      }

      const firstTransaction = toFirstTransaction(chosen.tx);
      console.info(
        `➕ ${info.name}: block ${firstTransaction.blockNumber} ${firstTransaction.timestamp} via ${chosen.source} (${toRelativePath(infoPath)})`,
      );
      result.updated++;

      if (!dryRun) {
        info.firstTransaction = firstTransaction;
        fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);
        chainChanged = true;
      }
    }

    if (chainChanged) {
      rebuildProvidersAllJson(network.path);
    }
  }

  console.info(
    `\n${dryRun ? "🔍 Dry run" : "✅ Scan complete"}: ${result.scanned} provider(s) scanned, ${result.updated} ${dryRun ? "would be " : ""}updated, ${result.unresolved} unresolved`,
  );
  return result;
}

if (isMain(import.meta.url)) {
  try {
    await scanFirstTransactions({
      dryRun: process.argv.includes("--dry-run"),
      force: process.argv.includes("--force"),
    });
  } catch (error) {
    console.error("❌ First-transaction scan failed:", error);
    process.exitCode = 1;
  }
}
