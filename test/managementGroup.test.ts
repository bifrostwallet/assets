import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { collectChainDrift } from "../src/chainDrift.js";
import type { ProviderInfo } from "../src/config.js";
import {
  applyManagementGroupDrift,
  collectManagementGroupDrift,
  warnUnknownManagementGroupMembers,
} from "../src/script/syncManagementGroup.js";

const flareMember = `0x${"11".repeat(20)}`;
const flareLeaving = `0x${"22".repeat(20)}`;
const flareStays = `0x${"66".repeat(20)}`;
const flareUnknown = `0x${"33".repeat(20)}`;
const songbirdMember = `0x${"44".repeat(20)}`;
const songbirdUnknown = `0x${"55".repeat(20)}`;

function writeProvider(
  chainPath: string,
  identity: string,
  name: string,
  managementGroup: boolean,
) {
  const dir = path.join(process.cwd(), "data", "providers", chainPath, identity);
  fs.mkdirSync(dir, { recursive: true });
  const info = {
    name,
    identityAddress: identity,
    logoURL: `providers/${chainPath}/${identity}/logo.webp`,
    managementGroup,
  };
  fs.writeFileSync(path.join(dir, "info.json"), `${JSON.stringify(info, null, 2)}\n`);
}

describe("management group membership", { concurrency: false }, () => {
  test("throws when a Management Group member read fails", async () => {
    await assert.rejects(
      () =>
        collectManagementGroupDrift({
          readMembers: async () => {
            throw new Error("getManagementGroupMembers failed: timeout");
          },
        }),
      /Management Group member read failed on Flare \(eip155-14\): getManagementGroupMembers failed: timeout/,
    );
  });

  test("throws when the Songbird member read fails after Flare succeeded", async () => {
    await assert.rejects(
      () =>
        collectManagementGroupDrift({
          readMembers: async (network) => {
            if (network.path === "eip155-14") return [];
            throw new Error("songbird rpc down");
          },
        }),
      /Management Group member read failed on Songbird \(eip155-19\): songbird rpc down/,
    );
  });

  test("applies membership flips and warns about unknown members", async () => {
    const original = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mg-drift-"));
    process.chdir(root);
    try {
      writeProvider("eip155-14", flareMember, "Flare Member", false);
      writeProvider("eip155-14", flareLeaving, "Flare Leaving", true);
      writeProvider("eip155-14", flareStays, "Flare Stays", true);
      writeProvider("eip155-19", songbirdMember, "Songbird Member", false);
      const staysPath = path.join(root, "data", "providers", "eip155-14", flareStays, "info.json");
      const staysBefore = fs.readFileSync(staysPath);

      const drift = await collectManagementGroupDrift({
        readMembers: async (network) => {
          if (network.path === "eip155-14") {
            return [flareMember.toUpperCase(), flareStays, flareUnknown];
          }
          if (network.path === "eip155-19") return [songbirdMember, songbirdUnknown];
          throw new Error(`unexpected network ${network.path}`);
        },
      });

      assert.deepEqual(
        drift.flips.map((flip) => `${flip.chainPath} ${flip.name} ${flip.catalog} ${flip.chain}`),
        [
          "eip155-14 Flare Member false true",
          "eip155-14 Flare Leaving true false",
          "eip155-19 Songbird Member false true",
        ],
      );
      assert.equal(drift.flareMembers, 3);
      assert.equal(drift.songbirdMembers, 2);
      assert.deepEqual(
        drift.unknown.map((group) => `${group.label} ${group.members.join(",")}`),
        [`Flare ${flareUnknown}`, `Songbird ${songbirdUnknown}`],
      );

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = ((...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      }) as typeof console.warn;
      try {
        warnUnknownManagementGroupMembers(drift);
      } finally {
        console.warn = originalWarn;
      }
      const warningText = warnings.join("\n");
      assert.match(warningText, new RegExp(flareUnknown));
      assert.match(warningText, new RegExp(songbirdUnknown));
      assert.match(warningText, /were not added/);
      assert.equal(warningText.includes(flareMember), false);

      const updated = applyManagementGroupDrift(drift);
      assert.equal(updated, 3);

      const readFlag = (chainPath: string, identity: string) => {
        const info = JSON.parse(
          fs.readFileSync(
            path.join(root, "data", "providers", chainPath, identity, "info.json"),
            "utf8",
          ),
        ) as ProviderInfo;
        return info.managementGroup;
      };
      assert.equal(readFlag("eip155-14", flareMember), true);
      assert.equal(readFlag("eip155-14", flareLeaving), false);
      assert.equal(readFlag("eip155-14", flareStays), true);
      assert.equal(readFlag("eip155-19", songbirdMember), true);
      assert.deepEqual(fs.readFileSync(staysPath), staysBefore);

      assert.equal(
        fs.existsSync(path.join(root, "data", "providers", "eip155-14", flareUnknown)),
        false,
      );
      assert.equal(
        fs.existsSync(path.join(root, "data", "providers", "eip155-19", songbirdUnknown)),
        false,
      );

      const flareAll = JSON.parse(
        fs.readFileSync(path.join(root, "data", "providers", "eip155-14", "all.json"), "utf8"),
      ) as ProviderInfo[];
      assert.equal(
        flareAll.find((provider) => provider.identityAddress === flareMember)?.managementGroup,
        true,
      );
      assert.equal(
        flareAll.find((provider) => provider.identityAddress === flareLeaving)?.managementGroup,
        false,
      );
      assert.equal(
        flareAll.some((provider) => provider.identityAddress === flareUnknown),
        false,
      );
    } finally {
      process.chdir(original);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("chain drift failed reads", { concurrency: false }, () => {
  test("throws when a strict EntityManager read fails", async () => {
    const original = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-drift-fail-"));
    process.chdir(root);
    try {
      const identity = `0x${"cd".repeat(20)}`;
      const dir = path.join(root, "data", "providers", "eip155-14", identity);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "info.json"),
        `${JSON.stringify({ name: "Drift Example", identityAddress: identity })}\n`,
      );

      await assert.rejects(
        () =>
          collectChainDrift({
            readEntityData: async (_identity, _network, options) => {
              assert.equal(options?.strict, true);
              throw new Error("getNodeIdsOf failed: rpc unavailable");
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Chain read failed for 1 provider/);
          assert.match(error.message, /Drift Example/);
          assert.match(error.message, /getNodeIdsOf failed: rpc unavailable/);
          assert.equal(error.message.includes("chain read failed ("), false);
          return true;
        },
      );
    } finally {
      process.chdir(original);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
