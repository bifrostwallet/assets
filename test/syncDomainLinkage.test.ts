import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DomainLinkageCheck } from "../src/domainLinkage.js";
import { isInconclusiveDomainLinkage } from "../src/domainLinkage.js";
import { domainLinkedValueToStore } from "../src/script/syncDomainLinkage.js";

function check(args: {
  linked?: boolean;
  fileMatched?: boolean;
  fileError?: string;
  fileChecked?: boolean;
  dnsMatched?: boolean;
  dnsError?: string;
  dnsChecked?: boolean;
}): DomainLinkageCheck {
  const fileMatched = args.fileMatched === true;
  const dnsMatched = args.dnsMatched === true;
  return {
    chainPath: "eip155-14",
    identityAddress: "0xabcdef0000000000000000000000000000000001",
    websiteURL: "https://example.com",
    expectedRecord: "eip155:14:0xabcdef0000000000000000000000000000000001",
    file: {
      checked: args.fileChecked ?? true,
      matched: fileMatched,
      error: args.fileError,
    },
    dns: {
      checked: args.dnsChecked ?? true,
      matched: dnsMatched,
      name: "_providers.example.com",
      error: args.dnsError,
    },
    linked: args.linked ?? (fileMatched || dnsMatched),
  };
}

describe("domain linkage sync", () => {
  test("transport failures leave the stored flag unchanged", () => {
    const timedOut = check({ fileError: "Timeout", dnsError: "Timeout" });
    assert.equal(isInconclusiveDomainLinkage(timedOut), true);
    assert.equal(domainLinkedValueToStore(true, timedOut), undefined);
    assert.equal(domainLinkedValueToStore(false, timedOut), undefined);
    assert.equal(domainLinkedValueToStore(undefined, timedOut), undefined);

    const connectAndDns = check({
      fileError: "Fetch failed",
      dnsError: "queryTxt ECONNREFUSED _providers.example.com",
    });
    assert.equal(isInconclusiveDomainLinkage(connectAndDns), true);
    assert.equal(domainLinkedValueToStore(true, connectAndDns), undefined);
  });

  test("a definitive miss updates the stored flag", () => {
    const httpMiss = check({ fileError: "HTTP 404", dnsError: "Timeout" });
    assert.equal(isInconclusiveDomainLinkage(httpMiss), false);
    assert.equal(domainLinkedValueToStore(true, httpMiss), false);

    const empty = check({ dnsError: "No TXT records" });
    assert.equal(isInconclusiveDomainLinkage(empty), false);
    assert.equal(domainLinkedValueToStore(true, empty), false);
    assert.equal(domainLinkedValueToStore(undefined, empty), false);

    const fileTimeoutDnsMiss = check({ fileError: "Timeout", dnsError: "No TXT records" });
    assert.equal(isInconclusiveDomainLinkage(fileTimeoutDnsMiss), false);
    assert.equal(domainLinkedValueToStore(true, fileTimeoutDnsMiss), false);

    const contradiction = check({
      linked: false,
      fileMatched: true,
      dnsError: "File and DNS linkage records contradict for this identity",
    });
    assert.equal(isInconclusiveDomainLinkage(contradiction), false);
    assert.equal(domainLinkedValueToStore(true, contradiction), false);
  });

  test("a match updates a stored false flag and skips an unchanged true flag", () => {
    const linked = check({ linked: true, fileMatched: true, dnsError: "Timeout" });
    assert.equal(isInconclusiveDomainLinkage(linked), false);
    assert.equal(domainLinkedValueToStore(false, linked), true);
    assert.equal(domainLinkedValueToStore(true, linked), undefined);
  });
});
