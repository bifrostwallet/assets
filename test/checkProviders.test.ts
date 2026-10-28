import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { checkNetwork } from "../src/script/checkProviders.js";

describe("check:providers epoch read", () => {
  it("warns and continues when the fsp-rewards read fails", async () => {
    const previousExit = process.exitCode;
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";

    const warn = mock.method(console, "warn", () => {});
    const info = mock.method(console, "info", () => {});
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      return new Response("rate limited", { status: 403 });
    });

    try {
      await checkNetwork({ key: "flare", chainPath: "not-a-chain" });

      assert.equal(process.exitCode, previousExit);
      const warnings = warn.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(
        warnings.some(
          (line) => line.includes("Epoch read skipped for flare") && line.includes("403"),
        ),
        `expected a skipped-read warning, got ${JSON.stringify(warnings)}`,
      );

      const firstCall = fetchMock.mock.calls[0];
      assert.ok(firstCall, "expected the shared GitHub client to request epoch ids");
      assert.match(
        String(firstCall.arguments[0]),
        /api\.github\.com\/repos\/flare-foundation\/fsp-rewards\/contents\/flare$/,
      );
      const init = firstCall.arguments[1] as { headers?: Record<string, string> };
      assert.equal(init.headers?.Authorization, "Bearer test-token");
    } finally {
      warn.mock.restore();
      info.mock.restore();
      fetchMock.mock.restore();
      process.exitCode = previousExit;
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousToken;
      }
    }
  });
});
