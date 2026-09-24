import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import { verifyProviderDomainLinkage } from "../domainLinkage.js";
import { isMain } from "../isMain.js";

/**
 * Checks which curated providers have completed optional domain linkage
 * (HTTPS /.well-known/providers.txt and/or DNS TXT _providers.<host>).
 *
 * Only allowlisted record lines are considered; all other file/TXT content
 * is ignored. Does not mutate the repository.
 *
 * Usage:
 *   ./yarn verify:provider-domains
 *   ./yarn verify:provider-domains --chain eip155-14
 *   ./yarn verify:provider-domains --identity 0x…
 */

function parseArgs(argv: string[]): { chainPath?: string; identity?: string } {
  let chainPath: string | undefined;
  let identity: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--chain") {
      chainPath = argv[++i];
    } else if (arg === "--identity") {
      identity = argv[++i]?.toLowerCase();
    } else if (arg === "--help" || arg === "-h") {
      console.info(
        "Usage: ./yarn verify:provider-domains [--chain eip155-14|eip155-19] [--identity 0x…]",
      );
      process.exit(0);
    }
  }
  return { chainPath, identity };
}

async function main(): Promise<void> {
  const { chainPath: onlyChain, identity: onlyIdentity } = parseArgs(process.argv.slice(2));
  const networks = Object.values(BLOCKCHAIN_NETWORKS).filter(
    (network) => network.entityManager && (!onlyChain || network.path === onlyChain),
  );

  if (onlyChain && networks.length === 0) {
    throw new Error(`Unknown or unsupported chain: ${onlyChain}`);
  }

  let linked = 0;
  let missing = 0;
  let errors = 0;

  for (const network of networks) {
    const chainDir = path.join(process.cwd(), "data", "providers", network.path);
    if (!fs.existsSync(chainDir)) continue;

    const identities = fs
      .readdirSync(chainDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !onlyIdentity || name === onlyIdentity)
      .sort();

    for (const identity of identities) {
      const infoPath = path.join(chainDir, identity, "info.json");
      if (!fs.existsSync(infoPath)) continue;
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;

      const result = await verifyProviderDomainLinkage({
        chainPath: network.path,
        identityAddress: info.identityAddress,
        websiteURL: info.websiteURL,
      });

      let fileStatus = "file✗";
      if (result.file.matched) {
        fileStatus = "file✓";
      } else if (result.file.error) {
        fileStatus = `file✗(${result.file.error})`;
      }

      let dnsStatus = "dns✗";
      if (result.dns.matched) {
        dnsStatus = "dns✓";
      } else if (result.dns.error) {
        dnsStatus = `dns✗(${result.dns.error})`;
      }

      if (result.linked) {
        linked++;
        console.info(`✅ ${network.path} ${identity}  ${fileStatus}  ${dnsStatus}`);
      } else if (result.file.error && result.dns.error) {
        errors++;
        console.info(`⚠️ ${network.path} ${identity}  ${fileStatus}  ${dnsStatus}`);
      } else {
        missing++;
        console.info(`❌ ${network.path} ${identity}  ${fileStatus}  ${dnsStatus}`);
      }
    }
  }

  console.info(
    `\nSummary: ${linked} linked, ${missing} missing, ${errors} unreachable/invalid website`,
  );
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error("❌ Domain linkage verification failed:", error);
    process.exitCode = 1;
  });
}
