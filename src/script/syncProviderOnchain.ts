import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, toRelativePath } from "../convert.js";
import { isMain } from "../isMain.js";
import { fetchEntityData } from "../onchain.js";

// Refreshes on-chain EntityManager data (addresses, public key, validator NodeIDs) for
// every curated provider, so validator lists stay current without manual edits.
//
// NOTE: On-chain fields are part of the provider-signed payload. Changing them
// invalidates existing signatures, so affected providers are listed at the end
// and must be re-signed (yarn sign:provider).

async function syncProviderOnchain(): Promise<void> {
  const providersDir = path.join(process.cwd(), "data", "providers");
  const changedProviders: string[] = [];

  for (const [, network] of Object.entries(BLOCKCHAIN_NETWORKS)) {
    if (!network.entityManager) continue;

    const chainDir = path.join(providersDir, network.path);
    if (!fs.existsSync(chainDir)) continue;

    console.info(`\n📡 Syncing ${network.name} providers from EntityManager...`);
    let chainChanged = false;

    for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const infoPath = path.join(chainDir, provider.name, "info.json");
      if (!fs.existsSync(infoPath)) continue;

      const before = fs.readFileSync(infoPath, "utf8");
      const info = JSON.parse(before) as ProviderInfo;

      const onchain = await fetchEntityData(info.identityAddress, network);
      const updated = sortProviderInfo({ ...info, ...onchain });

      const after = `${JSON.stringify(updated, null, 2)}\n`;
      if (after !== before) {
        fs.writeFileSync(infoPath, after);
        changedProviders.push(toRelativePath(infoPath));
        console.info(`🔄 ${info.name}: on-chain data changed (${toRelativePath(infoPath)})`);
        chainChanged = true;
      }
    }

    if (chainChanged) {
      rebuildProvidersAllJson(network.path);
    }
  }

  if (changedProviders.length === 0) {
    console.info("\n✅ All providers already match on-chain data");
    return;
  }

  console.info(`\n✅ Updated ${changedProviders.length} provider(s) from on-chain data`);
  console.warn(
    "\n⚠️ On-chain fields are signed. The following providers need re-signing (yarn sign:provider):",
  );
  for (const changed of changedProviders) {
    console.warn(`   ${changed}`);
  }
}

if (isMain(import.meta.url)) {
  syncProviderOnchain().catch((error) => {
    console.error("❌ On-chain provider sync failed:", error);
    process.exitCode = 1;
  });
}

export default syncProviderOnchain;
