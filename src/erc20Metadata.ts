import { createPublicClient, decodeAbiParameters, encodeFunctionData, type Hex, http } from "viem";
import { assertCuratedName, assertCuratedSymbol, TokenMetadataError } from "./tokenSymbols.js";

const stringOutput = [{ type: "string" }] as const;
const decimalsOutput = [{ type: "uint8" }] as const;

function functionAbi(name: "name" | "symbol" | "decimals") {
  return [
    {
      type: "function",
      name,
      stateMutability: "view",
      inputs: [],
      outputs: name === "decimals" ? decimalsOutput : stringOutput,
    },
  ] as const;
}

/** Calldata for one ERC-20 metadata getter. The selector ignores the output type. */
export function erc20CallData(functionName: "name" | "symbol" | "decimals"): Hex {
  return encodeFunctionData({
    abi: functionAbi(functionName),
    functionName,
  });
}

export type Erc20Call = (data: Hex) => Promise<Hex>;

export type Erc20Metadata = {
  name: string;
  symbol: string;
  decimals: number;
};

function byteLength(data: Hex): number {
  return (data.length - 2) / 2;
}

/**
 * Decode an ERC-20 `name()` or `symbol()` return.
 * A 32-byte payload is the MKR-style bytes32 form and is refused.
 */
export function decodeErc20String(data: Hex, field: "name" | "symbol"): string {
  if (!data.startsWith("0x") || data === "0x") {
    throw new TokenMetadataError(`${field}() returned an empty response`);
  }
  const size = byteLength(data);
  if (!Number.isInteger(size)) {
    throw new TokenMetadataError(`${field}() returned malformed data`);
  }
  if (size === 32) {
    throw new TokenMetadataError(
      `${field}() returned bytes32; MKR-style bytes32 tokens are not supported`,
    );
  }
  try {
    const [decoded] = decodeAbiParameters([{ type: "string" }], data);
    if (typeof decoded !== "string" || decoded.includes("\u0000")) {
      throw new TokenMetadataError(`${field}() did not return a string`);
    }
    return decoded;
  } catch (error) {
    if (error instanceof TokenMetadataError) throw error;
    throw new TokenMetadataError(`${field}() did not return a string`);
  }
}

export function decodeErc20Decimals(data: Hex): number {
  if (!data.startsWith("0x") || data === "0x") {
    throw new TokenMetadataError("decimals() returned an empty response");
  }
  try {
    const [decoded] = decodeAbiParameters([{ type: "uint8" }], data);
    const decimals = Number(decoded);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new TokenMetadataError(`decimals() returned ${String(decoded)}`);
    }
    return decimals;
  } catch (error) {
    if (error instanceof TokenMetadataError) throw error;
    throw new TokenMetadataError("decimals() did not return a uint8");
  }
}

async function callGetter(
  call: Erc20Call,
  functionName: "name" | "symbol" | "decimals",
): Promise<Hex> {
  try {
    const data = await call(erc20CallData(functionName));
    if (!data || data === "0x") {
      throw new TokenMetadataError(`${functionName}() returned an empty response`);
    }
    return data;
  } catch (error) {
    if (error instanceof TokenMetadataError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new TokenMetadataError(`Could not read ${functionName}(): ${message}`);
  }
}

/**
 * Read one token. Name and symbol are trimmed. Internal spaces are kept.
 * Empty strings, `.` in the symbol, and bytes32 returns throw {@link TokenMetadataError}.
 */
export async function readErc20Metadata(call: Erc20Call): Promise<Erc20Metadata> {
  const [nameRaw, symbolRaw, decimalsRaw] = await Promise.all([
    callGetter(call, "name"),
    callGetter(call, "symbol"),
    callGetter(call, "decimals"),
  ]);
  return {
    name: assertCuratedName(decodeErc20String(nameRaw, "name")),
    symbol: assertCuratedSymbol(decodeErc20String(symbolRaw, "symbol")),
    decimals: decodeErc20Decimals(decimalsRaw),
  };
}

export async function readErc20MetadataFromRpc(
  chainId: number,
  rpcUrl: string,
  address: Hex,
): Promise<Erc20Metadata> {
  const client = createPublicClient({
    chain: {
      id: chainId,
      name: `eip155-${chainId}`,
      nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { timeout: 20000, retryCount: 2 }),
  });
  return readErc20Metadata(async (data) => {
    const result = await client.call({ to: address, data });
    return result.data ?? "0x";
  });
}
