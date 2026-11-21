import { createGcsClient } from "../gcs.js";
import {
  type IntakeSubmission,
  ingestProviderAttestation,
  ingestProviderSubmission,
  intakeSubmissionToDir,
} from "../ingest.js";
import {
  assertAttestationIntakeDocument,
  assertProviderIntakeDocument,
  isAllowedIntakeObjectName,
  MAX_INTAKE_OBJECT_BYTES,
  parseIntakeJsonObject,
} from "../intakeGuard.js";

// Pulls pending provider submissions and attestations from the intake bucket
// (written by the intake service, apps/intake) and ingests them into
// data/providers. A dapp-kind document is skipped: dapps are curated by the
// Bifrost team, the same as tokens and contracts.
//
// Object names and document shapes are allowlisted before any write. Crypto and
// on-chain checks in ingest* are the second line of defense.
//
// Read-only: this repository never writes to or deletes from a bucket. An
// ingested object is reported as up to date on later runs until the "Cleanup
// merged intake objects" workflow in bifrostwallet/assets-intake deletes it,
// once its public fields and signatures are on main.
//
// Run by the scheduled pull-submissions GitHub Action, or locally:
//   ./yarn with:ops-config -- ./yarn pull:submissions
// Auth is GCS_ACCESS_TOKEN, or `gcloud auth print-access-token` when unset
// (see src/gcs.ts).

const DAPP_SKIP_REASON = "dapp submissions are not ingested; dapps are curated by the Bifrost team";

function logSkippedDapp(name: string): void {
  console.warn(`⏭️ ${name}: skipped (${DAPP_SKIP_REASON})`);
}

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
  const gcs = createGcsClient();
  const files = await gcs.list(INTAKE_BUCKET);
  const submissions = files.filter((file) => file.name.endsWith(".json"));

  console.info(`📥 ${submissions.length} object(s) ending in .json in gs://${INTAKE_BUCKET}`);

  let ingested = 0;
  let unchanged = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of submissions) {
    try {
      // Dapp objects used to be allowlisted. Skip them before any parse so a
      // leftover intake object cannot fail the provider ingest path.
      if (file.name.startsWith("dapps/")) {
        skipped++;
        logSkippedDapp(file.name);
        continue;
      }

      if (!isAllowedIntakeObjectName(file.name)) {
        skipped++;
        console.warn(`⏭️ ${file.name}: skipped (object name not on allowlist)`);
        continue;
      }

      const size = file.size;
      if (!Number.isFinite(size) || size <= 0 || size > MAX_INTAKE_OBJECT_BYTES) {
        throw new Error(`Object size out of range: ${size}`);
      }

      // Pinned to the listed generation, so the size check above covers these bytes.
      const contents = await gcs.download(INTAKE_BUCKET, file.name, {
        generation: file.generation,
        maxBytes: MAX_INTAKE_OBJECT_BYTES,
      });
      if (contents === undefined) {
        skipped++;
        console.warn(`⏭️ ${file.name}: skipped (replaced or removed since listing)`);
        continue;
      }

      const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      const doc = parseIntakeJsonObject(text);

      if (doc.kind === "dapp") {
        skipped++;
        logSkippedDapp(file.name);
        continue;
      }

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
