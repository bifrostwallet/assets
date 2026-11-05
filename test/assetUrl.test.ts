import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  resolveAssetURL,
  toRelativeAssetPath,
  withAbsoluteLogoURL,
  withRelativeLogoURL,
} from "../src/assetUrl.js";
import { DEFAULT_ASSET_BASE_URL } from "../src/config.js";

const RELATIVE = "providers/eip155-14/0xabc/logo.webp";
const TOKEN = "tokens/eip155-14/0xabc/logo.webp";
const DAPP = "dapps/example/logo.webp";
const BASE = "https://cdn.example.com/assets";
const JOINED = `https://cdn.example.com/assets/${RELATIVE}`;

describe("resolveAssetURL", () => {
  test("joins a relative logoURL to the caller base", () => {
    assert.equal(resolveAssetURL(RELATIVE, BASE), JOINED);
    assert.equal(resolveAssetURL(RELATIVE, `${BASE}/`), JOINED);
    assert.equal(resolveAssetURL(`/${RELATIVE}`, BASE), JOINED);
    assert.equal(resolveAssetURL(TOKEN, `${BASE}/`), `https://cdn.example.com/assets/${TOKEN}`);
    assert.equal(resolveAssetURL(DAPP, BASE), `https://cdn.example.com/assets/${DAPP}`);
  });

  test("omitted base falls back to the GitHub raw data prefix", () => {
    const previous = process.env.ASSET_BASE_URL;
    delete process.env.ASSET_BASE_URL;
    try {
      assert.match(DEFAULT_ASSET_BASE_URL, /^https:\/\/raw\.githubusercontent\.com\/.+\/data\/$/);
      assert.equal(resolveAssetURL(RELATIVE), `${DEFAULT_ASSET_BASE_URL}${RELATIVE}`);
    } finally {
      if (previous === undefined) delete process.env.ASSET_BASE_URL;
      else process.env.ASSET_BASE_URL = previous;
    }
  });

  test("rebases an already-absolute logoURL onto the caller base", () => {
    const github = `${DEFAULT_ASSET_BASE_URL}${RELATIVE}`;
    const staticHost = `https://cdn.example.com/static/${RELATIVE}`;
    const otherPrefix = `https://assets.example.com/bucket/${TOKEN}?v=1`;
    assert.equal(resolveAssetURL(github, BASE), JOINED);
    assert.equal(resolveAssetURL(staticHost, `${BASE}/`), JOINED);
    assert.equal(resolveAssetURL(otherPrefix, BASE), `https://cdn.example.com/assets/${TOKEN}`);
    assert.equal(toRelativeAssetPath(github), RELATIVE);
    assert.equal(toRelativeAssetPath(staticHost), RELATIVE);
    assert.equal(toRelativeAssetPath(otherPrefix), TOKEN);

    const unknown = "https://images.example.com/unrelated.png";
    assert.equal(resolveAssetURL(unknown, BASE), unknown);
    assert.equal(withRelativeLogoURL({ logoURL: github }).logoURL, RELATIVE);
  });

  test("requires https for a passed base and an absolute logo URL", () => {
    assert.throws(() => resolveAssetURL(RELATIVE, "http://cdn.example.com/assets"), /https:\/\//);
    assert.throws(
      () => resolveAssetURL("http://cdn.example.com/providers/eip155-14/0xabc/logo.webp", BASE),
      /https:\/\//,
    );
    assert.throws(
      () => toRelativeAssetPath("http://cdn.example.com/providers/eip155-14/0xabc/logo.webp"),
      /https:\/\//,
    );
    assert.equal(
      resolveAssetURL(RELATIVE, "HTTPS://cdn.example.com/assets"),
      `HTTPS://cdn.example.com/assets/${RELATIVE}`,
    );
  });

  test("bucket upload can still rewrite logoURL onto an operator base", () => {
    const operator = "https://operator.example/static/";
    const once = withAbsoluteLogoURL({ logoURL: RELATIVE }, operator);
    const twice = withAbsoluteLogoURL(once, operator);
    assert.equal(once.logoURL, `${operator}${RELATIVE}`);
    assert.equal(twice.logoURL, once.logoURL);
    assert.equal(
      withAbsoluteLogoURL({ logoURL: `${DEFAULT_ASSET_BASE_URL}${DAPP}` }, operator).logoURL,
      `${operator}${DAPP}`,
    );

    const tokenGithub = `${DEFAULT_ASSET_BASE_URL}${TOKEN}`;
    const tokenOnOperator = `${operator}${TOKEN}`;
    assert.equal(withAbsoluteLogoURL({ logoURL: tokenGithub }).logoURL, tokenGithub);
    assert.equal(
      withAbsoluteLogoURL({ logoURL: tokenGithub }, DEFAULT_ASSET_BASE_URL).logoURL,
      tokenGithub,
    );
    assert.equal(withAbsoluteLogoURL({ logoURL: tokenGithub }, operator).logoURL, tokenOnOperator);
    assert.equal(
      withAbsoluteLogoURL({ logoURL: tokenOnOperator }, operator).logoURL,
      tokenOnOperator,
    );
  });
});
