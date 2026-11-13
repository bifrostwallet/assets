import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { formatChainDriftSummary } from "../src/chainDrift.js";
import {
  buildCatalogRefreshSummary,
  DOMAIN_LINKAGE_SUMMARY_FILE,
  formatDomainLinkageSection,
  parseArgs,
  readCarriedDomainLinkageSection,
  writeDomainLinkageSection,
} from "../src/script/refreshProviders.js";
import { formatDualNetworkSection } from "../src/script/syncDualNetwork.js";
import { formatManagementGroupSummary } from "../src/script/syncManagementGroup.js";

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-summary-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("refresh provider flags", () => {
  test("--skip-delist is set only when the flag is present", () => {
    assert.equal(parseArgs([]).skipDelist, false);
    assert.equal(parseArgs(["--write-domain", "--skip-chain"]).skipDelist, false);
    assert.equal(parseArgs(["--write-domain", "--skip-chain", "--skip-delist"]).skipDelist, true);
    assert.equal(
      parseArgs(["--write-delist", "--write-chain", "--skip-domain"]).skipDelist,
      false,
    );
  });

  test("the nightly workflow scans listing fees once, on the chain pass", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/refresh-providers.yml"),
      "utf8",
    );
    const commands = [...workflow.matchAll(/\.\/yarn refresh:providers[^\n]*/g)].map(
      (match) => match[0],
    );
    assert.deepEqual(commands, [
      "./yarn refresh:providers --write-domain --skip-chain --skip-delist",
      "./yarn refresh:providers --write-delist --write-chain --write-dual-network --skip-domain",
    ]);
  });
});

describe("domain linkage summary", () => {
  test("formats persisted and dry-run sections", () => {
    assert.equal(
      formatDomainLinkageSection({ checked: 40, linked: 12, updated: 3 }, true),
      ["## Domain linkage", "", "- Checked: 40", "- Linked: 12", "- Updated: 3", ""].join("\n"),
    );
    assert.match(
      formatDomainLinkageSection({ checked: 1, linked: 0, updated: 1 }, false),
      /- Would update: 1/,
    );
  });

  test("sidecar filename is gitignored", () => {
    assert.equal(DOMAIN_LINKAGE_SUMMARY_FILE, "domain-linkage-summary.md");
    const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    assert.match(gitignore, /^domain-linkage-summary\.md$/m);
  });

  test("round-trips the domain section through the sidecar", () => {
    withTempDir((dir) => {
      const section = formatDomainLinkageSection({ checked: 4, linked: 2, updated: 2 }, true);
      writeDomainLinkageSection(section, dir);
      assert.equal(readCarriedDomainLinkageSection(dir), section);
      assert.equal(fs.existsSync(path.join(dir, DOMAIN_LINKAGE_SUMMARY_FILE)), true);
    });
  });

  test("adds a trailing newline when the sidecar omitted one", () => {
    withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, DOMAIN_LINKAGE_SUMMARY_FILE), "## Domain linkage");
      assert.equal(readCarriedDomainLinkageSection(dir), "## Domain linkage\n");
    });
  });

  test("returns undefined when the sidecar is missing or blank", () => {
    withTempDir((dir) => {
      assert.equal(readCarriedDomainLinkageSection(dir), undefined);
      fs.writeFileSync(path.join(dir, DOMAIN_LINKAGE_SUMMARY_FILE), " \n");
      assert.equal(readCarriedDomainLinkageSection(dir), undefined);
    });
  });

  test("a later run keeps the carried domain section and can report real chain drift", () => {
    withTempDir((dir) => {
      const section = formatDomainLinkageSection({ checked: 8, linked: 5, updated: 2 }, true);
      writeDomainLinkageSection(section, dir);
      const summary = buildCatalogRefreshSummary(
        "No listed providers burned FSP rewards or charge a delegation fee above Bifrost's 50% listing cap.",
        formatChainDriftSummary([
          {
            chainPath: "flare",
            identityAddress: "0xabc",
            name: "Example",
            infoPath: "unused",
            changes: [{ field: "delegationAddress", catalog: "0x111", chain: "0x999" }],
            observed: {},
          },
        ]),
        readCarriedDomainLinkageSection(dir),
      );
      assert.equal(summary.split("## Domain linkage").length - 1, 1);
      assert.match(summary, /- Updated: 2/);
      assert.match(summary, /delegationAddress/);
      assert.equal(summary.includes("Chain comparison was skipped"), false);
      assert.equal(summary.includes("No provider chain fields differ"), false);
    });
  });

  test("a skipped chain comparison is labeled skipped and still includes domain linkage", () => {
    const section = formatDomainLinkageSection({ checked: 8, linked: 5, updated: 2 }, true);
    const summary = buildCatalogRefreshSummary(
      "No listed providers burned FSP rewards or charge a delegation fee above Bifrost's 50% listing cap.",
      formatChainDriftSummary([], { skipped: true }),
      section,
    );
    assert.match(summary, /Chain comparison was skipped\./);
    assert.equal(summary.includes("No provider chain fields differ"), false);
    assert.equal(summary.split("## Domain linkage").length - 1, 1);
  });

  test("places management group flips and unknown-member warnings beside chain drift", () => {
    const chainSummary = formatChainDriftSummary([]);
    const managementGroupSummary = formatManagementGroupSummary({
      flips: [
        {
          chainPath: "eip155-14",
          identityAddress: "0xabc",
          name: "Example",
          infoPath: "unused",
          catalog: false,
          chain: true,
        },
      ],
      unknown: [
        {
          label: "Flare",
          chainPath: "eip155-14",
          members: ["0x9999999999999999999999999999999999999999"],
        },
      ],
      flareMembers: 2,
      songbirdMembers: 0,
    });
    const domain = formatDomainLinkageSection({ checked: 8, linked: 5, updated: 2 }, true);
    const summary = buildCatalogRefreshSummary(
      "delist",
      chainSummary,
      domain,
      managementGroupSummary,
    );

    const chainAt = summary.indexOf("No provider chain fields differ from EntityManager");
    const memberAt = summary.indexOf("`managementGroup`: `false` → `true`");
    const warningAt = summary.indexOf("Warning:");
    const domainAt = summary.indexOf("## Domain linkage");
    assert.ok(chainAt >= 0);
    assert.ok(memberAt > chainAt);
    assert.ok(warningAt > memberAt);
    assert.ok(domainAt > warningAt);
    assert.match(summary, /0x9999999999999999999999999999999999999999/);
    assert.match(summary, /were not added/);
    assert.equal(summary.split("## Domain linkage").length - 1, 1);
  });

  test("a skipped management group comparison is labeled skipped", () => {
    const summary = buildCatalogRefreshSummary(
      "delist",
      formatChainDriftSummary([], { skipped: true }),
      undefined,
      formatManagementGroupSummary(
        { flips: [], unknown: [], flareMembers: 0, songbirdMembers: 0 },
        { skipped: true },
      ),
    );
    assert.match(summary, /Chain comparison was skipped\./);
    assert.match(summary, /Management Group comparison was skipped\./);
    assert.equal(summary.includes("No provider managementGroup flags differ"), false);
  });

  test("places the dual network line after domain linkage", () => {
    const summary = buildCatalogRefreshSummary(
      "delist",
      formatChainDriftSummary([]),
      formatDomainLinkageSection({ checked: 1, linked: 0, updated: 0 }, true),
      formatManagementGroupSummary({
        flips: [],
        unknown: [],
        flareMembers: 0,
        songbirdMembers: 0,
      }),
      formatDualNetworkSection(4, true),
    );
    const domainAt = summary.indexOf("## Domain linkage");
    const dualAt = summary.indexOf("## Dual network");
    assert.ok(domainAt >= 0);
    assert.ok(dualAt > domainAt);
    assert.match(summary, /## Dual network\n\n- Updated: 4/);
  });

  test("a preview dual network line says it would update", () => {
    assert.equal(
      formatDualNetworkSection(2, false),
      ["## Dual network", "", "- Would update: 2", ""].join("\n"),
    );
  });

  test("omits domain linkage when this run skipped it and no sidecar exists", () => {
    withTempDir((dir) => {
      const summary = buildCatalogRefreshSummary(
        "delist",
        formatChainDriftSummary([]),
        readCarriedDomainLinkageSection(dir),
      );
      assert.equal(summary.includes("Domain linkage"), false);
      assert.match(summary, /No provider chain fields differ from EntityManager/);
    });
  });
});
