import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BLOCKCHAIN_NETWORKS, FLARE_CONTRACT_REGISTRY } from "../src/config.js";
import {
  CHAIN_RPC_RETRY_COUNT,
  CHAIN_RPC_RETRY_DELAY_MS,
  type ChainContractReader,
  createNetworkClient,
  fetchEntityData,
  fetchManagementGroupMembers,
} from "../src/onchain.js";

const IDENTITY = `0x${"ab".repeat(20)}`;

const ENTITY_READS = [
  "getDelegationAddressOf",
  "getVoterAddresses",
  "getPublicKeyOf",
  "getNodeIdsOf",
] as const;

function reader(failing?: string): ChainContractReader {
  return {
    async readContract(args) {
      if (failing && args.functionName === failing) {
        throw new Error("rpc unavailable");
      }
      switch (args.functionName) {
        case "getDelegationAddressOf":
          return "0x1111111111111111111111111111111111111111";
        case "getVoterAddresses":
          return {
            submitAddress: "0x2222222222222222222222222222222222222222",
            submitSignaturesAddress: "0x3333333333333333333333333333333333333333",
            signingPolicyAddress: "0x4444444444444444444444444444444444444444",
          };
        case "getPublicKeyOf":
          return [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`];
        case "getNodeIdsOf":
          return [];
        default:
          throw new Error(`unexpected ${args.functionName}`);
      }
    },
  };
}

describe("on-chain reads", () => {
  test("chain client retries HTTP 429 with viem exponential backoff", () => {
    assert.equal(CHAIN_RPC_RETRY_COUNT, 5);
    assert.equal(CHAIN_RPC_RETRY_DELAY_MS, 1_000);

    const client = createNetworkClient(BLOCKCHAIN_NETWORKS.flare);
    assert.equal(client.transport.retryCount, CHAIN_RPC_RETRY_COUNT);
    assert.equal(client.transport.retryDelay, CHAIN_RPC_RETRY_DELAY_MS);
    assert.equal(client.chain?.rpcUrls.default.http[0], BLOCKCHAIN_NETWORKS.flare.rpc);

    // viem waits (2 ** attempt) * retryDelay before each retry.
    const delays = Array.from(
      { length: CHAIN_RPC_RETRY_COUNT },
      (_, attempt) => (1 << attempt) * CHAIN_RPC_RETRY_DELAY_MS,
    );
    assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);
  });

  for (const functionName of ENTITY_READS) {
    test(`strict entity read throws when ${functionName} fails`, async () => {
      await assert.rejects(
        () =>
          fetchEntityData(IDENTITY, BLOCKCHAIN_NETWORKS.flare, {
            strict: true,
            client: reader(functionName),
          }),
        new RegExp(`${functionName} failed: rpc unavailable`),
      );
    });
  }

  test("a successful strict getNodeIdsOf keeps validators on the result", async () => {
    const observed = await fetchEntityData(IDENTITY, BLOCKCHAIN_NETWORKS.flare, {
      strict: true,
      client: reader(),
    });
    assert.deepEqual(observed.validators, []);
    assert.equal(observed.delegationAddress, "0x1111111111111111111111111111111111111111");
  });

  test("includeManagementGroup sets the flag from the mocked member list", async () => {
    const member = await fetchEntityData(IDENTITY, BLOCKCHAIN_NETWORKS.flare, {
      client: reader(),
      includeManagementGroup: true,
      readManagementGroupMembers: async () => [IDENTITY.toUpperCase()],
    });
    assert.equal(member.managementGroup, true);

    const outsider = await fetchEntityData(IDENTITY, BLOCKCHAIN_NETWORKS.songbird, {
      client: reader(),
      includeManagementGroup: true,
      readManagementGroupMembers: async () => [`0x${"12".repeat(20)}`],
    });
    assert.equal(outsider.managementGroup, false);
  });

  test("includeManagementGroup throws when the member read fails", async () => {
    await assert.rejects(
      () =>
        fetchEntityData(IDENTITY, BLOCKCHAIN_NETWORKS.flare, {
          client: reader(),
          includeManagementGroup: true,
          readManagementGroupMembers: async () => {
            throw new Error("registry timeout");
          },
        }),
      /Management Group member read failed for .* on Flare: registry timeout/,
    );
  });

  test("fetchManagementGroupMembers reads PollingManagementGroup and lowercases members", async () => {
    const calls: { functionName: string; address: string; args?: readonly unknown[] }[] = [];
    const members = await fetchManagementGroupMembers(BLOCKCHAIN_NETWORKS.flare, {
      client: {
        async readContract(args) {
          calls.push({
            functionName: args.functionName,
            address: args.address,
            args: args.args,
          });
          if (args.functionName === "getContractAddressByName") {
            return "0xABCDEF0000000000000000000000000000000001";
          }
          if (args.functionName === "getManagementGroupMembers") {
            return ["0xABCDEF0000000000000000000000000000000002"];
          }
          throw new Error(args.functionName);
        },
      },
    });

    assert.deepEqual(
      calls.map((call) => call.functionName),
      ["getContractAddressByName", "getManagementGroupMembers"],
    );
    assert.equal(calls[0]?.address, FLARE_CONTRACT_REGISTRY);
    assert.deepEqual(calls[0]?.args, ["PollingManagementGroup"]);
    assert.equal(calls[1]?.address, "0xABCDEF0000000000000000000000000000000001");
    assert.deepEqual(members, ["0xabcdef0000000000000000000000000000000002"]);
  });

  test("fetchManagementGroupMembers throws when the registry read fails", async () => {
    await assert.rejects(
      () =>
        fetchManagementGroupMembers(BLOCKCHAIN_NETWORKS.songbird, {
          client: {
            async readContract() {
              throw new Error("header not found");
            },
          },
        }),
      /PollingManagementGroup read failed on Songbird \(eip155-19\): header not found/,
    );
  });
});
