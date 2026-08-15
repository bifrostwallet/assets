import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { ProviderInfo } from "../src/config.js";
import {
  isValidEvmAddress,
  isValidImage,
  isValidName,
  isValidNodeID,
  isValidPublicKey,
  isValidURL,
} from "../src/validate.js";

function validateProviderInfo(providerInfo: ProviderInfo): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate name
  if (!isValidName(providerInfo.name)) {
    errors.push("Invalid name");
  }

  // TODO: Enable once we have a description and website URL, if we care about them?
  /*
  // Validate description (even if empty)
  if (!isValidDescription(providerInfo.description)) {
    errors.push("Invalid description");
  }

  // Validate website URL (even if empty)
  if (!isValidUrl(providerInfo.websiteURL, "website")) {
    errors.push("Invalid website URL");
  }
  */
  // Validate EVM addresses — catalog form is always lowercase (canonical)
  const addressFields = [
    "identityAddress",
    "delegationAddress",
    "signingPolicyAddress",
    "submitAddress",
    "submitSignaturesAddress",
  ] as const;
  for (const field of addressFields) {
    const value = providerInfo[field];
    if (!isValidEvmAddress(value)) {
      errors.push(`Invalid ${field}`);
    } else if (value !== value.toLowerCase()) {
      errors.push(`${field} must be lowercase`);
    }
  }
  if (providerInfo.publicKey && providerInfo.publicKey !== providerInfo.publicKey.toLowerCase()) {
    errors.push("publicKey must be lowercase");
  }

  // Validate public key
  if (!isValidPublicKey(providerInfo.publicKey)) {
    errors.push("Invalid public key");
  }

  // Validate validators array
  if (!Array.isArray(providerInfo.validators)) {
    errors.push("Validators must be an array");
  } else {
    // Check each validator node ID
    for (let i = 0; i < providerInfo.validators.length; i++) {
      if (!isValidNodeID(providerInfo.validators[i])) {
        errors.push(`Invalid validator node ID at index ${i}`);
      }
    }
  }

  // Validate links if present
  if (providerInfo.links) {
    if (typeof providerInfo.links !== "object") {
      errors.push("Links must be an object");
    } else {
      // Validate each link
      for (const [platform, url] of Object.entries(providerInfo.links)) {
        if (typeof url !== "string") {
          errors.push(`Link media URL for ${platform} must be a string`);
        } else if (!isValidURL(url, platform as keyof typeof providerInfo.links)) {
          errors.push(`Invalid ${platform} URL: ${url}`);
        }
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// Find all files with a specific name in the providers directory
function findFilesWithName(baseDir: string, targetFileName: string): string[] {
  const foundFiles: string[] = [];

  function processDirectory(dirPath: string): void {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        // Recursively process subdirectories
        processDirectory(itemPath);
      } else if (stats.isFile() && item === targetFileName) {
        foundFiles.push(itemPath);
      }
    }
  }

  processDirectory(baseDir);
  return foundFiles;
}

// Tests run from dist/test, so resolve the repo root relative to this file's
// compiled location won't work with __dirname alone; use process.cwd(), which
// is the repo root when running `./yarn test`.
const PROVIDERS_DIR = path.resolve(process.cwd(), "data/providers");

describe("Provider info validation", () => {
  const providerInfoFiles = findFilesWithName(PROVIDERS_DIR, "info.json");

  // Fail the test if no provider files are found
  test("Provider info files should exist", () => {
    assert.ok(providerInfoFiles.length > 0);
  });

  // Create a test for each provider info file
  for (const filePath of providerInfoFiles) {
    const relativePath = path.relative(process.cwd(), filePath);

    test(`Provider info file ${relativePath} should be valid`, () => {
      // Read and parse the file
      const fileContent = fs.readFileSync(filePath, "utf8");
      let providerInfo: ProviderInfo;

      try {
        providerInfo = JSON.parse(fileContent) as ProviderInfo;
      } catch (error) {
        console.error(`Error parsing file ${filePath}:`, error);
        assert.fail(`Failed to parse JSON in ${filePath}`);
      }

      const validationResult = validateProviderInfo(providerInfo);
      assert.equal(
        validationResult.isValid,
        true,
        `Provider info file ${filePath} is invalid. Errors: ${validationResult.errors.join(", ")}`,
      );
    });
  }
});

describe("Provider logo validation", () => {
  const providerLogoFiles = findFilesWithName(PROVIDERS_DIR, "logo.webp");

  // Fail the test if no logo files are found
  test("Provider logo files should exist", () => {
    assert.ok(providerLogoFiles.length > 0);
  });

  // Create a test for each provider logo file
  for (const filePath of providerLogoFiles) {
    const relativePath = path.relative(process.cwd(), filePath);

    test(`Provider logo file ${relativePath} should be valid`, () => {
      const validationResult = isValidImage(filePath);

      assert.equal(
        validationResult.isValid,
        true,
        `Logo file ${relativePath} is invalid: ${validationResult.errors.join(", ")}`,
      );
    });
  }
});

describe("Provider files consistency", () => {
  test("Each chain directory should have matching info.json and logo.webp files", () => {
    // Get all chain directories (e.g., eip155-14)
    const chainDirs = fs.readdirSync(PROVIDERS_DIR).filter((item) => {
      const itemPath = path.join(PROVIDERS_DIR, item);
      return fs.statSync(itemPath).isDirectory() && item.startsWith("eip155-");
    });

    assert.ok(chainDirs.length > 0);

    for (const chainDir of chainDirs) {
      const chainPath = path.join(PROVIDERS_DIR, chainDir);
      const providerDirs = fs
        .readdirSync(chainPath)
        .filter((item) => fs.statSync(path.join(chainPath, item)).isDirectory());

      // Skip empty chain directories
      if (providerDirs.length === 0) continue;

      const infoFiles = findFilesWithName(chainPath, "info.json");
      const logoFiles = findFilesWithName(chainPath, "logo.webp");

      // Only log providers missing files
      if (infoFiles.length !== providerDirs.length || logoFiles.length !== providerDirs.length) {
        // Log which provider directories are missing files
        for (const providerDir of providerDirs) {
          const providerPath = path.join(chainPath, providerDir);
          const hasInfo = fs.existsSync(path.join(providerPath, "info.json"));
          const hasLogo = fs.existsSync(path.join(providerPath, "logo.webp"));

          if (!hasInfo || !hasLogo) {
            console.error(
              `Provider ${chainDir}/${providerDir} missing files: ${!hasInfo ? "info.json" : ""} ${!hasLogo ? "logo.webp" : ""}`,
            );
          }
        }
      }

      assert.equal(infoFiles.length, providerDirs.length);
      assert.equal(logoFiles.length, providerDirs.length);
      assert.equal(infoFiles.length, logoFiles.length);
    }
  });

  test("Each chain directory should have a valid and complete all.json file", () => {
    // Get all chain directories (e.g., eip155-14)
    const chainDirs = fs.readdirSync(PROVIDERS_DIR).filter((item) => {
      const itemPath = path.join(PROVIDERS_DIR, item);
      return fs.statSync(itemPath).isDirectory() && item.startsWith("eip155-");
    });

    assert.ok(chainDirs.length > 0);

    for (const chainDir of chainDirs) {
      const chainPath = path.join(PROVIDERS_DIR, chainDir);
      const providerDirs = fs
        .readdirSync(chainPath)
        .filter((item) => fs.statSync(path.join(chainPath, item)).isDirectory());

      // Skip empty chain directories
      if (providerDirs.length === 0) continue;

      // Check that all.json exists
      const allJsonPath = path.join(chainPath, "all.json");
      assert.equal(fs.existsSync(allJsonPath), true);

      // Read and parse all.json
      const allJsonContent = fs.readFileSync(allJsonPath, "utf8");
      const allProviders = JSON.parse(allJsonContent) as ProviderInfo[];

      // Check that the length matches the number of provider directories
      assert.equal(allProviders.length, providerDirs.length);

      // Create a set of provider addresses from all.json for quick lookup
      const providerAddressesInAll = new Set(
        allProviders.map((p) => p.identityAddress.toLowerCase()),
      );

      // Check each provider directory to ensure it's in all.json
      for (const providerDir of providerDirs) {
        const infoJsonPath = path.join(chainPath, providerDir, "info.json");
        assert.ok(
          fs.existsSync(infoJsonPath),
          `Provider directory ${providerDir} is missing info.json file`,
        );

        const providerInfo = JSON.parse(fs.readFileSync(infoJsonPath, "utf8")) as ProviderInfo;
        const providerAddress = providerInfo.identityAddress.toLowerCase();

        assert.ok(
          providerAddressesInAll.has(providerAddress),
          `Provider ${providerDir} (address: ${providerInfo.identityAddress}) is not included in ${chainDir}/all.json`,
        );
      }

      // Also check that every entry in all.json corresponds to an actual provider directory
      for (const provider of allProviders) {
        // Find the directory name for this provider
        // This assumes directory names match identity addresses (adjust if needed)
        const matchingDir = providerDirs.find((dir) => {
          try {
            const dirInfoPath = path.join(chainPath, dir, "info.json");
            if (!fs.existsSync(dirInfoPath)) return false;

            const dirInfo = JSON.parse(fs.readFileSync(dirInfoPath, "utf8")) as ProviderInfo;
            return dirInfo.identityAddress.toLowerCase() === provider.identityAddress.toLowerCase();
          } catch {
            return false;
          }
        });

        assert.ok(
          matchingDir,
          `Provider in all.json with address ${provider.identityAddress} has no corresponding directory`,
        );
      }
    }
  });
});
