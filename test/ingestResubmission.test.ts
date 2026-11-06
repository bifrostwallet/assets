import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderInfo } from "../src/config.js";
import { providerLogoPath, sha256Hex } from "../src/convert.js";
import {
  dappListingTypedData,
  PROVIDER_VERIFICATION_INSTRUCTIONS,
  providerListingTypedData,
} from "../src/eip712.js";
import {
  formatPendingDappReviewSection,
  type IntakeDappSubmission,
  type IntakeSubmission,
  ingestDappSubmission,
  ingestProviderSubmission,
  intakeSubmissionToDir,
  type PendingDappReview,
} from "../src/ingest.js";
import type { SignatureEntry, SignaturesData } from "../src/verify.js";

const ORIGINAL_SUBMITTED_AT = "2026-10-18T00:26:11.817Z";
const RESUBMITTED_AT = "2026-11-03T00:00:00.000Z";
const SUBMITTER_CHANGED_FLAG =
  "submitter changed: verify with the original submitter before applying";
const URL_CHANGED_FLAG = "url changed: verify with the original submitter before applying";

const logo = fs.readFileSync(path.join(process.cwd(), "data/dapps/kinetic-market/logo.webp"));
const logoHash = sha256Hex(logo);

function snapshotFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        out.set(rel, fs.readFileSync(full));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

function readPendingReviews(): PendingDappReview[] {
  const filePath = path.join(process.cwd(), "data", "dapps", "pending-review.json");
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PendingDappReview[];
}

function assertSnapshotUnchanged(dir: string, beforeSnapshot: Map<string, Buffer>): void {
  const afterSnapshot = snapshotFiles(dir);
  assert.deepEqual([...afterSnapshot.keys()].sort(), [...beforeSnapshot.keys()].sort());
  for (const [rel, bytes] of beforeSnapshot) {
    assert.deepEqual(afterSnapshot.get(rel), bytes, rel);
  }
}

function entityFields(identity: string): Partial<ProviderInfo> {
  return {
    delegationAddress: identity,
    signingPolicyAddress: identity,
    submitAddress: identity,
    submitSignaturesAddress: identity,
    publicKey: `0x${"11".repeat(64)}`,
    validators: [],
  };
}

async function providerSignature(
  info: Partial<ProviderInfo>,
  account: ReturnType<typeof privateKeyToAccount>,
): Promise<SignatureEntry> {
  const typed = providerListingTypedData(info, 14);
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return {
    signerName: String(info.name),
    signerAddress: account.address,
    messageHash: typed.contentHash,
    signature,
    date: ORIGINAL_SUBMITTED_AT,
  };
}

function providerInfo(identity: string, description: string): ProviderInfo {
  return {
    name: "Test Provider",
    description,
    logoURL: providerLogoPath("eip155-14", identity),
    logoHash,
    websiteURL: "https://example.com",
    links: {},
    identityAddress: identity,
    delegationAddress: identity,
    signingPolicyAddress: identity,
    submitAddress: identity,
    submitSignaturesAddress: identity,
    publicKey: `0x${"11".repeat(64)}`,
    validators: [],
    acknowledgedResponsibilities: true,
    listed: false,
    managementGroup: false,
    domainLinked: false,
    dualNetwork: false,
  };
}

async function ingestProvider(
  identity: string,
  description: string,
  signatures: SignatureEntry[],
  submittedAt: string,
) {
  const info = providerInfo(identity, description);
  const submission: IntakeSubmission = {
    version: 1,
    chainPath: "eip155-14",
    info,
    signatures: {
      identityAddress: identity,
      verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
      signatures,
    } satisfies SignaturesData,
    logoBase64: logo.toString("base64"),
    submittedAt,
  };
  const sourceDir = intakeSubmissionToDir(submission);
  return ingestProviderSubmission(sourceDir, {
    chainPath: "eip155-14",
    readEntityData: async () => entityFields(identity),
  });
}

async function dappSubmission(
  account: ReturnType<typeof privateKeyToAccount>,
  description: string,
  submittedAt: string,
  url: string,
): Promise<IntakeDappSubmission> {
  const payload = {
    title: "Resubmit Dapp",
    description,
    url,
    chains: ["eip155:14"],
    category: "dex",
    categoryOther: "",
    logoHash,
  };
  const typed = dappListingTypedData(payload);
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return {
    version: 1,
    kind: "dapp",
    info: {
      title: payload.title,
      description: payload.description,
      url: payload.url,
      chains: payload.chains,
      category: payload.category,
    },
    submitter: account.address,
    messageHash: typed.contentHash,
    signature,
    logoBase64: logo.toString("base64"),
    submittedAt,
  };
}

describe("Intake resubmission provenance", { concurrency: false }, () => {
  const originalCwd = process.cwd();
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "assets-ingest-resubmit-"));
    process.chdir(root);
  });

  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keeps provider provenance when info.json and the logo are unchanged", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider used to test intake resubmission.";
    const selfSignature = await providerSignature(providerInfo(identity, description), account);

    const first = await ingestProvider(
      identity,
      description,
      [selfSignature],
      ORIGINAL_SUBMITTED_AT,
    );
    assert.equal(first.status, "ingested");

    const providerDir = path.join(root, "data", "providers", "eip155-14", identity);
    const chainDir = path.join(root, "data", "providers", "eip155-14");
    const beforeSnapshot = snapshotFiles(chainDir);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(providerDir, "provenance.json"), "utf8"),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, ORIGINAL_SUBMITTED_AT);

    const second = await ingestProvider(identity, description, [selfSignature], RESUBMITTED_AT);
    assert.equal(second.status, "unchanged");
    assertSnapshotUnchanged(chainDir, beforeSnapshot);
  });

  test("keeps provider provenance when only signatures change", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const attester = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider used to test signature-only resubmission.";
    const info = providerInfo(identity, description);
    const selfSignature = await providerSignature(info, account);

    const first = await ingestProvider(
      identity,
      description,
      [selfSignature],
      ORIGINAL_SUBMITTED_AT,
    );
    assert.equal(first.status, "ingested");

    const providerDir = path.join(root, "data", "providers", "eip155-14", identity);
    const provenancePath = path.join(providerDir, "provenance.json");
    const provenanceBefore = fs.readFileSync(provenancePath);

    const extra = await providerSignature(info, attester);
    const second = await ingestProvider(
      identity,
      description,
      [selfSignature, extra],
      RESUBMITTED_AT,
    );
    assert.equal(second.status, "ingested");
    assert.deepEqual(fs.readFileSync(provenancePath), provenanceBefore);

    const signatures = JSON.parse(
      fs.readFileSync(path.join(providerDir, "signatures.json"), "utf8"),
    ) as SignaturesData;
    assert.equal(signatures.signatures.length, 2);
  });

  test("updates provider provenance when info.json changes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const original = "A provider used to test a real catalog change.";
    const updated = "A provider whose description changed on resubmission.";
    const firstSignature = await providerSignature(providerInfo(identity, original), account);
    const first = await ingestProvider(identity, original, [firstSignature], ORIGINAL_SUBMITTED_AT);
    assert.equal(first.status, "ingested");

    const secondSignature = await providerSignature(providerInfo(identity, updated), account);
    const second = await ingestProvider(identity, updated, [secondSignature], RESUBMITTED_AT);
    assert.equal(second.status, "ingested");

    const provenance = JSON.parse(
      fs.readFileSync(
        path.join(root, "data", "providers", "eip155-14", identity, "provenance.json"),
        "utf8",
      ),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, RESUBMITTED_AT);
  });

  test("keeps dapp provenance when info.json and the logo are unchanged", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const description = "A dapp used to test intake resubmission.";
    const url = "https://resubmit-example.com";
    const first = await ingestDappSubmission(
      await dappSubmission(account, description, ORIGINAL_SUBMITTED_AT, url),
    );
    assert.equal(first.status, "ingested");

    const dappDir = path.join(root, "data", "dapps", "resubmit-example-com");
    const beforeSnapshot = snapshotFiles(dappDir);

    const second = await ingestDappSubmission(
      await dappSubmission(account, description, RESUBMITTED_AT, url),
    );
    assert.equal(second.status, "unchanged");
    assertSnapshotUnchanged(dappDir, beforeSnapshot);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(dappDir, "provenance.json"), "utf8"),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, ORIGINAL_SUBMITTED_AT);
  });

  test("updates dapp provenance when info.json changes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const url = "https://changed-example.com";
    const original = "A dapp used to test a real catalog change.";
    const updated = "A dapp whose description changed on resubmission.";
    const first = await ingestDappSubmission(
      await dappSubmission(account, original, ORIGINAL_SUBMITTED_AT, url),
    );
    assert.equal(first.status, "ingested");

    const second = await ingestDappSubmission(
      await dappSubmission(account, updated, RESUBMITTED_AT, url),
    );
    assert.equal(second.status, "ingested");
    const provenance = JSON.parse(
      fs.readFileSync(
        path.join(root, "data", "dapps", "changed-example-com", "provenance.json"),
        "utf8",
      ),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, RESUBMITTED_AT);
  });

  test("records a different path on the same host without changing the listing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const url = "https://path-example.com";
    const description = "A dapp used to test a same-host path conflict.";
    const first = await ingestDappSubmission(
      await dappSubmission(account, description, ORIGINAL_SUBMITTED_AT, url),
    );
    assert.equal(first.status, "ingested");
    const dappDir = path.join(root, "data", "dapps", "path-example-com");
    const beforeSnapshot = snapshotFiles(dappDir);

    const second = await ingestDappSubmission(
      await dappSubmission(account, description, RESUBMITTED_AT, "https://path-example.com/other"),
    );
    assert.equal(second.status, "pending");
    assertSnapshotUnchanged(dappDir, beforeSnapshot);
    assert.equal(fs.existsSync(path.join(root, "data", "dapps", "path-example-com-other")), false);

    const review = readPendingReviews().find((entry) => entry.slug === "path-example-com");
    assert.ok(review);
    assert.equal(review.flag, URL_CHANGED_FLAG);
    assert.equal(review.oldSubmitter, account.address.toLowerCase());
    assert.equal(review.newSubmitter, account.address.toLowerCase());
    assert.equal(review.oldUrl, url);
    assert.equal(review.newUrl, "https://path-example.com/other");
    const section = formatPendingDappReviewSection([review]);
    assert.match(section, /url changed: verify with the original submitter before applying/);
    assert.match(section, /old URL: https:\/\/path-example.com/);
    assert.match(section, /new URL: https:\/\/path-example.com\/other/);
  });

  test("gives the www host its own slug and leaves the bare host untouched", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const description = "A dapp used to test a www host as its own entry.";
    const first = await ingestDappSubmission(
      await dappSubmission(account, description, ORIGINAL_SUBMITTED_AT, "https://bare-example.com"),
    );
    assert.equal(first.status, "ingested");
    assert.equal(first.slug, "bare-example-com");
    const bareDir = path.join(root, "data", "dapps", "bare-example-com");
    const beforeSnapshot = snapshotFiles(bareDir);

    const second = await ingestDappSubmission(
      await dappSubmission(other, description, RESUBMITTED_AT, "https://www.bare-example.com"),
    );
    assert.equal(second.status, "ingested");
    assert.equal(second.slug, "www-bare-example-com");
    assertSnapshotUnchanged(bareDir, beforeSnapshot);
    const wwwInfo = JSON.parse(
      fs.readFileSync(
        path.join(root, "data", "dapps", "www-bare-example-com", "info.json"),
        "utf8",
      ),
    ) as { url: string };
    assert.equal(wwwInfo.url, "https://www.bare-example.com");
    const touched = readPendingReviews().filter(
      (entry) => entry.slug === "bare-example-com" || entry.slug === "www-bare-example-com",
    );
    assert.equal(touched.length, 0);
  });

  test("records a different submitter without changing the listing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const description = "A dapp used to test a different submitter.";
    const url = "https://submitter-example.com";
    const first = await ingestDappSubmission(
      await dappSubmission(account, description, ORIGINAL_SUBMITTED_AT, url),
    );
    assert.equal(first.status, "ingested");
    const dappDir = path.join(root, "data", "dapps", "submitter-example-com");
    const beforeSnapshot = snapshotFiles(dappDir);

    const second = await ingestDappSubmission(
      await dappSubmission(other, description, RESUBMITTED_AT, url),
    );
    assert.equal(second.status, "pending");
    assertSnapshotUnchanged(dappDir, beforeSnapshot);

    const reviews = readPendingReviews().filter((entry) => entry.slug === "submitter-example-com");
    assert.equal(reviews.length, 1);
    const review = reviews[0];
    assert.ok(review);
    assert.equal(review.flag, SUBMITTER_CHANGED_FLAG);
    assert.equal(review.oldSubmitter, account.address.toLowerCase());
    assert.equal(review.newSubmitter, other.address.toLowerCase());
    assert.equal(review.oldUrl, url);
    assert.equal(review.newUrl, url);
    const section = formatPendingDappReviewSection(reviews);
    assert.match(section, /submitter changed: verify with the original submitter before applying/);
    assert.match(section, new RegExp(`old submitter: ${account.address.toLowerCase()}`));
    assert.match(section, new RegExp(`new submitter: ${other.address.toLowerCase()}`));
    assert.match(section, /old URL: https:\/\/submitter-example.com/);
    assert.match(section, /new URL: https:\/\/submitter-example.com/);

    const third = await ingestDappSubmission(
      await dappSubmission(other, description, RESUBMITTED_AT, url),
    );
    assert.equal(third.status, "unchanged");
    assertSnapshotUnchanged(dappDir, beforeSnapshot);
    assert.equal(
      readPendingReviews().filter((entry) => entry.slug === "submitter-example-com").length,
      1,
    );
  });

  test("updates a pre-www folder in place when the URL and submitter match", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const url = "https://www.legacy-example.com";
    const slug = "legacy-example-com";
    const dappDir = path.join(root, "data", "dapps", slug);
    fs.mkdirSync(dappDir, { recursive: true });
    fs.writeFileSync(
      path.join(dappDir, "info.json"),
      `${JSON.stringify({
        title: "Legacy Www",
        description: "A legacy www listing used to test a stable folder id.",
        url,
        logoURL: `dapps/${slug}/logo.webp`,
        logoHash,
        chains: ["eip155:14"],
      })}\n`,
    );
    fs.writeFileSync(path.join(dappDir, "logo.webp"), logo);
    fs.writeFileSync(
      path.join(dappDir, "provenance.json"),
      `${JSON.stringify({
        submittedAt: ORIGINAL_SUBMITTED_AT,
        submitter: account.address.toLowerCase(),
        messageHash: `0x${"ab".repeat(32)}`,
        signature: "0xabc",
      })}\n`,
    );

    const updated = "A legacy www listing whose description changed in place.";
    const result = await ingestDappSubmission(
      await dappSubmission(account, updated, RESUBMITTED_AT, url),
    );
    assert.equal(result.status, "ingested");
    assert.equal(result.slug, slug);
    assert.equal(fs.existsSync(path.join(root, "data", "dapps", "www-legacy-example-com")), false);
    const info = JSON.parse(fs.readFileSync(path.join(dappDir, "info.json"), "utf8")) as {
      url: string;
      logoURL: string;
      description: string;
    };
    assert.equal(info.url, url);
    assert.equal(info.logoURL, `dapps/${slug}/logo.webp`);
    assert.equal(info.description, updated);
  });
});
