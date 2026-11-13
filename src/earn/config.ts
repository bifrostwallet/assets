export type ChainName = "flare" | "songbird";

export interface ChainConfig {
  name: ChainName;
  chainPath: string;
  /** Only Flare has P-chain staking (MIRROR claims + validator rewards). */
  hasValidators: boolean;
}

export const CHAINS: ChainConfig[] = [
  { name: "flare", chainPath: "eip155-14", hasValidators: true },
  { name: "songbird", chainPath: "eip155-19", hasValidators: false },
];
