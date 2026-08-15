import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExplorerTx,
  firstOutgoing,
  toFirstTransaction,
} from "../src/script/scanFirstTransaction.js";

const PROVIDER = "0xAbCd000000000000000000000000000000000001";
const ENTITY_MANAGER = "0x134b3311c6bded895556807a30c7f047d99dfdc2";

function tx(overrides: Partial<ExplorerTx> = {}): ExplorerTx {
  return {
    hash: `0x${"1".repeat(64)}`,
    blockNumber: "1000",
    timeStamp: "1628596800",
    from: PROVIDER,
    to: "0x0000000000000000000000000000000000000002",
    isError: "0",
    ...overrides,
  };
}

describe("firstOutgoing", () => {
  it("skips incoming transactions (funding does not count as activity)", () => {
    const funding = tx({ from: "0x0000000000000000000000000000000000000009", to: PROVIDER });
    const submit = tx({ blockNumber: "2000", hash: `0x${"2".repeat(64)}` });
    assert.equal(firstOutgoing([funding, submit], PROVIDER), submit);
  });

  it("skips failed transactions", () => {
    const failed = tx({ isError: "1" });
    const ok = tx({ blockNumber: "2000", hash: `0x${"2".repeat(64)}` });
    assert.equal(firstOutgoing([failed, ok], PROVIDER), ok);
  });

  it("matches sender case-insensitively", () => {
    const submit = tx({ from: PROVIDER.toUpperCase().replace("0X", "0x") });
    assert.equal(firstOutgoing([submit], PROVIDER.toLowerCase()), submit);
  });

  it("restricts to the recipient when given (EntityManager registration)", () => {
    const unrelated = tx();
    const registration = tx({
      blockNumber: "3000",
      hash: `0x${"3".repeat(64)}`,
      to: ENTITY_MANAGER,
    });
    assert.equal(firstOutgoing([unrelated, registration], PROVIDER, ENTITY_MANAGER), registration);
  });

  it("returns undefined when nothing matches", () => {
    assert.equal(firstOutgoing([tx()], "0x0000000000000000000000000000000000000042"), undefined);
  });
});

describe("toFirstTransaction", () => {
  it("converts explorer strings to block number and ISO timestamp", () => {
    const converted = toFirstTransaction(tx({ blockNumber: "424242", timeStamp: "1628596800" }));
    assert.deepEqual(converted, {
      hash: `0x${"1".repeat(64)}`,
      blockNumber: 424242,
      timestamp: "2021-08-10T12:00:00.000Z",
    });
  });
});
