import { Storage } from "@google-cloud/storage";
import {
  type IntakeDappSubmission,
  type IntakeSubmission,
  ingestDappSubmission,
  ingestProviderAttestation,
  ingestProviderSubmission,
  intakeSubmissionToDir,
} from "../ingest.js";
import {
  assertAttestationIntakeDocument,
  assertDappIntakeDocument,
  assertProviderIntakeDocument,
  isAllowedIntakeObjectName,
  MAX_INTAKE_OBJECT_BYTES,
  parseIntakeJsonObject,
} from "../intakeGuard.js";

// Pulls pending submissions from the intake bucket (written by the intake
// service, apps/intake) and ingests them into data/providers and data/dapps.
//
// Object names and document shapes are allowlisted before any write. Crypto and
// on-chain checks in ingest* are the second line of defense.
//
// Run by the scheduled pull-submissions GitHub Action, or locally:
//   yarn pull:submissions

function requireIntakeBucket(): string {
  const bucket = process.env.INTAKE_BUCKET;
  if (!bucket) {
    throw new Error(
      "INTAKE_BUCKET is required. In CI set repository variable INTAKE_BUCKET; locally use ./yarn with:ops-config -- ./yarn pull:submissions",
    );
  }
  return bucket;
}

async function pullSubmissions(): Promise<void> {
  const INTAKE_BUCKET = requireIntakeBucket();
  const storage = new Storage();
  const [files] = await storage.bucket(INTAKE_BUCKET).getFiles();
  const submissions = files.filter((file) => file.name.endsWith(".json"));

  console.info(`📥 ${submissions.length} object(s) ending in .json in gs://${INTAKE_BUCKET}`);

  let ingested = 0;
  let unchanged = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of submissions) {
    try {
      if (!isAllowedIntakeObjectName(file.name)) {
        skipped++;
        console.warn(`⏭️ ${file.name}: skipped (object name not on allowlist)`);
        continue;
      }

      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size ?? 0);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_INTAKE_OBJECT_BYTES) {
        throw new Error(`Object size out of range: ${metadata.size}`);
      }

      const [contents] = await file.download();
      if (contents.length > MAX_INTAKE_OBJECT_BYTES) {
        throw new Error("Downloaded object exceeds max size");
      }

      const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      const doc = parseIntakeJsonObject(text);

      let status: "ingested" | "unchanged";
      if (file.name.startsWith("attestations/")) {
        const sanitized = assertAttestationIntakeDocument(doc);
        // Object path must match the document: attestations/<chain>/<target>/<attester>.json
        const [, pathChain, pathTarget, pathAttesterFile] = file.name.split("/");
        if (pathChain !== sanitized.chainPath) {
          throw new Error("Object path chain does not match document chainPath");
        }
        if (pathTarget !== sanitized.targetIdentityAddress) {
          throw new Error("Object path target does not match document target");
        }
        if (pathAttesterFile?.replace(/\.json$/, "") !== sanitized.attestation.signerAddress) {
          throw new Error("Object path attester does not match document signer");
        }
        const result = await ingestProviderAttestation(sanitized);
        status = result.status;
      } else if (file.name.startsWith("dapps/")) {
        const sanitized = assertDappIntakeDocument(doc);
        // Object path must match submitter + slug derived later in ingest
        const pathSubmitter = file.name.split("/")[1];
        if (pathSubmitter !== sanitized.submitter) {
          throw new Error("Object path submitter does not match document submitter");
        }
        const result = await ingestDappSubmission(sanitized as IntakeDappSubmission);
        status = result.status;
      } else {
        const sanitized = assertProviderIntakeDocument(doc);
        const pathIdentity = file.name.split("/")[1]?.replace(/\.json$/, "");
        const identity = String(sanitized.info.identityAddress).toLowerCase();
        if (pathIdentity !== identity) {
          throw new Error("Object path identity does not match document identity");
        }
        if (file.name.split("/")[0] !== sanitized.chainPath) {
          throw new Error("Object path chain does not match document chainPath");
        }
        const providerSubmission: IntakeSubmission = {
          version: 1,
          chainPath: sanitized.chainPath,
          info: sanitized.info as unknown as IntakeSubmission["info"],
          signatures: sanitized.signatures as unknown as IntakeSubmission["signatures"],
          logoBase64: sanitized.logoBase64,
          submittedAt: sanitized.submittedAt,
        };
        const sourceDir = intakeSubmissionToDir(providerSubmission);
        const result = await ingestProviderSubmission(sourceDir, {
          chainPath: providerSubmission.chainPath,
        });
        status = result.status;
      }

      if (status === "ingested") {
        ingested++;
        console.info(`✅ ${file.name}: ingested`);
      } else {
        unchanged++;
        console.info(`⏭️ ${file.name}: already up to date`);
      }

      // Drop from the intake queue after a successful pull so stale objects are
      // not re-processed every night. Failures stay for ops inspection.
      await file.delete({ ignoreNotFound: true });
      console.info(`🗑️ ${file.name}: removed from intake bucket`);
    } catch (error) {
      failed++;
      console.error(`❌ ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.info(
    `\nSummary: ${ingested} ingested, ${unchanged} unchanged, ${failed} failed, ${skipped} skipped`,
  );
}

pullSubmissions().catch((error) => {
  console.error("❌ Pulling submissions failed:", error);
  process.exitCode = 1;
});
