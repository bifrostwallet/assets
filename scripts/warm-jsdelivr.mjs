#!/usr/bin/env node

// Warm jsDelivr's cache for every file under data/providers/ at one git tag.
//
// A fresh tag is fetched from GitHub on first request. jsDelivr caches a 403
// from that origin for about 60 seconds, so each failed file is retried on
// its own timer ~61s after that failure (not in lockstep rounds), up to
// MAX_ATTEMPTS, while other requests keep running.
//
// The process exits 0 even when some files stay cold. Those paths are listed
// in a GitHub Actions warning. Tokens, contracts, and dapps are not requested.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CDN_ORIGIN = "https://cdn.jsdelivr.net";
const GITHUB_REPO = "bifrostwallet/assets";
const PROVIDERS_DIR = "data/providers";
const CONCURRENCY = 32;
const MAX_ATTEMPTS = 8;
const RETRY_DELAY_MS = 61_000;
const REQUEST_TIMEOUT_MS = 30_000;
const WARNING_CHUNK = 3500;
const TAG_RE = /^[A-Za-z0-9._+-]+$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.error("Usage: node scripts/warm-jsdelivr.mjs <tag>");
}

function parseTag(argv) {
  if (argv.length !== 3) {
    usage();
    process.exit(1);
  }
  const tag = argv[2];
  if (
    !tag ||
    !TAG_RE.test(tag) ||
    tag.startsWith(".") ||
    tag.startsWith("-") ||
    tag.includes("..")
  ) {
    console.error(`Refusing tag ${JSON.stringify(tag)}`);
    process.exit(1);
  }
  return tag;
}

function providerFileUrl(tag, relativePath) {
  // Tag is one validated segment (no slash, space, or @), same as the release
  // URL builder. Encode each path segment so a space or plus cannot retarget it.
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${CDN_ORIGIN}/gh/${GITHUB_REPO}@${tag}/${encodedPath}`;
}

function assertProviderRelative(relativePath) {
  const segments = relativePath.split("/");
  if (
    path.isAbsolute(relativePath) ||
    !relativePath.startsWith(`${PROVIDERS_DIR}/`) ||
    segments.includes("..") ||
    segments.includes("")
  ) {
    throw new Error(`Refusing path outside ${PROVIDERS_DIR}: ${relativePath}`);
  }
}

async function listProviderFiles() {
  const root = path.join(repoRoot, ...PROVIDERS_DIR.split("/"));
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code === "ENOENT") {
        throw new Error(`Missing ${PROVIDERS_DIR} in ${repoRoot}`);
      }
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(repoRoot, full).split(path.sep).join("/");
      assertProviderRelative(relativePath);
      files.push(relativePath);
    }
  }

  await walk(root);
  files.sort();
  if (files.length === 0) {
    throw new Error(`No files under ${PROVIDERS_DIR}`);
  }
  return files;
}

function describeResult(result) {
  if (!result.ok && result.error) return result.error;
  if (result.status === 0) return result.error || "error";
  return String(result.status);
}

async function fetchProviderFile(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "*/*",
        "user-agent": "bifrostwallet-assets-warm-jsdelivr",
      },
    });
    // Drain the body so the edge finishes storing the object. Counting headers
    // alone can leave the fill incomplete.
    await response.arrayBuffer();
    let finalHost = "";
    try {
      finalHost = new URL(response.url).hostname;
    } catch {
      finalHost = "";
    }
    const onCdn = finalHost === "cdn.jsdelivr.net";
    return {
      ok: response.ok && onCdn,
      status: response.status,
      error: onCdn ? "" : "off-cdn",
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const errorLabel = name === "TimeoutError" || name === "AbortError" ? "timeout" : name;
    return { ok: false, status: 0, error: errorLabel };
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class JobQueue {
  constructor(items) {
    this.items = [...items];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }
    this.items.push(item);
    return true;
  }

  shift() {
    if (this.items.length > 0) {
      const item = this.items.shift();
      return Promise.resolve(item === undefined ? null : item);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter(null);
    }
  }
}

function escapeWorkflowCommand(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function emitColdWarnings(files) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    const extra = file.length + 2;
    if (current.length > 0 && size + extra > WARNING_CHUNK) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += extra;
  }
  if (current.length > 0) chunks.push(current);

  // One annotation when the list fits. A longer list is split so the
  // workflow command stays under GitHub's annotation limit. Every path is
  // also printed above as a normal log line.
  for (const chunk of chunks) {
    const message = `jsDelivr did not cache ${files.length} provider file(s): ${chunk.join(", ")}`;
    console.log(`::warning::${escapeWorkflowCommand(message)}`);
  }
}

function logProgress(ctx) {
  const done = ctx.warmed + ctx.cold.length;
  if (done !== ctx.total && done % CONCURRENCY !== 0) return;
  console.log(
    `progress warmed=${ctx.warmed} cold=${ctx.cold.length} waiting=${ctx.delayed} requests=${ctx.requests} elapsed_ms=${Date.now() - ctx.startedAt}`,
  );
}

function noteFirstPass(job, ctx) {
  if (job.attempt !== 1) return;
  ctx.firstPassFinished += 1;
  if (ctx.firstPassFinished !== ctx.total) return;
  const waiting = ctx.total - ctx.warmed - ctx.cold.length;
  console.log(
    `first pass warmed=${ctx.warmed} retrying=${waiting} cold=${ctx.cold.length} elapsed_ms=${Date.now() - ctx.startedAt}`,
  );
}

function finishFile(queue, ctx) {
  ctx.remaining -= 1;
  logProgress(ctx);
  if (ctx.remaining === 0) queue.close();
}

async function runJob(job, queue, ctx) {
  ctx.requests += 1;
  const url = providerFileUrl(ctx.tag, job.file);
  const result = await fetchProviderFile(url);
  const label = describeResult(result);
  ctx.responses.set(label, (ctx.responses.get(label) ?? 0) + 1);

  if (result.ok) {
    ctx.warmed += 1;
    noteFirstPass(job, ctx);
    finishFile(queue, ctx);
    return;
  }

  if (job.attempt < MAX_ATTEMPTS) {
    ctx.delayed += 1;
    console.log(
      `retry ${job.file} in ${RETRY_DELAY_MS / 1000}s (attempt ${job.attempt}/${MAX_ATTEMPTS}, ${label})`,
    );
    // Do not await this timer. The slot is free for another file immediately.
    const timer = sleep(RETRY_DELAY_MS).then(() => {
      ctx.delayed -= 1;
      const accepted = queue.push({ file: job.file, attempt: job.attempt + 1 });
      if (!accepted) {
        ctx.cold.push(job.file);
        finishFile(queue, ctx);
      }
    });
    ctx.timers.push(timer);
    noteFirstPass(job, ctx);
    return;
  }

  ctx.cold.push(job.file);
  console.warn(`cold ${job.file} after ${job.attempt} attempts (${label})`);
  noteFirstPass(job, ctx);
  finishFile(queue, ctx);
}

async function worker(queue, ctx) {
  for (;;) {
    const job = await queue.shift();
    if (!job) return;
    await runJob(job, queue, ctx);
  }
}

function printSummary(ctx) {
  const elapsedMs = Date.now() - ctx.startedAt;
  const responses = [...ctx.responses.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([label, count]) => `${label}=${count}`)
    .join(" ");
  const cold = [...ctx.cold].sort();

  console.log(
    `warm-jsdelivr: tag=${ctx.tag} files=${ctx.total} warmed=${ctx.warmed} cold=${cold.length} requests=${ctx.requests} elapsed_ms=${elapsedMs}`,
  );
  console.log(`responses: ${responses || "none"}`);
  if (cold.length === 0) return;

  console.log("Files jsDelivr did not cache:");
  for (const file of cold) {
    console.log(`  ${file}`);
  }
  emitColdWarnings(cold);
}

async function main() {
  const tag = parseTag(process.argv);
  const files = await listProviderFiles();
  for (const file of files) {
    assertProviderRelative(file);
  }

  console.log(
    `Warming ${files.length} file(s) under ${PROVIDERS_DIR}/ at ${GITHUB_REPO}@${tag} (concurrency ${CONCURRENCY}, up to ${MAX_ATTEMPTS} attempts, retry ${RETRY_DELAY_MS}ms after each failure)`,
  );

  const ctx = {
    tag,
    total: files.length,
    remaining: files.length,
    warmed: 0,
    cold: [],
    delayed: 0,
    requests: 0,
    firstPassFinished: 0,
    responses: new Map(),
    timers: [],
    startedAt: Date.now(),
  };
  const queue = new JobQueue(files.map((file) => ({ file, attempt: 1 })));
  const workers = [];
  const workerCount = Math.min(CONCURRENCY, files.length);
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(worker(queue, ctx));
  }

  await Promise.all(workers);
  await Promise.all(ctx.timers);
  if (ctx.remaining !== 0 || ctx.delayed !== 0) {
    throw new Error(
      `Warm stopped with ${ctx.remaining} file(s) unfinished and ${ctx.delayed} retry timer(s)`,
    );
  }
  printSummary(ctx);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
