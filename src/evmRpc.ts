/**
 * Per-chain RPC env vars shared by token curation.
 * Catalog-wide CI does not set these, so `check:tokens` skips on-chain reads
 * unless an operator exports one. `add:token` reads a single contract.
 */

export const RPC_ENV_BY_CHAIN: Readonly<Record<number, string>> = {
  1: "ETHEREUM_NODE_URL",
  10: "OPTIMISM_NODE_URL",
  14: "FLARE_NODE_URL",
  19: "SONGBIRD_NODE_URL",
  50: "XDC_NODE_URL",
  56: "BNBSMARTCHAIN_NODE_URL",
  137: "POLYGON_NODE_URL",
  250: "FANTOM_NODE_URL",
  8453: "BASE_NODE_URL",
  42161: "ARBITRUM_NODE_URL",
  999: "HYPERLIQUID_NODE_URL",
};

export function chainIdFromPath(chainPath: string): number | null {
  const match = /^eip155-(\d+)$/.exec(chainPath);
  return match ? Number(match[1]) : null;
}

export function rpcEnvNameForChain(chainId: number): string | undefined {
  return RPC_ENV_BY_CHAIN[chainId];
}

/** Trimmed RPC URL for a chain, or undefined when the env var is missing or blank. */
export function rpcUrlForChain(
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = RPC_ENV_BY_CHAIN[chainId];
  if (!name) return undefined;
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function supportedTokenRpcChains(): {
  chainPath: string;
  chainId: number;
  envName: string;
}[] {
  return Object.entries(RPC_ENV_BY_CHAIN)
    .map(([id, envName]) => ({
      chainId: Number(id),
      envName,
      chainPath: `eip155-${id}`,
    }))
    .sort((left, right) => left.chainId - right.chainId);
}
