#!/usr/bin/env node
// Edge firewall acceptance (app-business-core #511: "SQLi/path-traversal
// payloads to the production URL are blocked at the edge; normal traffic
// passes"; #755: the direct host address refuses traffic that skipped the proxy).
//
//   node scripts/edge-check.mjs https://<production address> [--direct https://<app>.vercel.app]
//
// Sends every attack in config/edge-check-payloads.json and expects it refused
// (403, or 429 for a challenge/limit); sends every ordinary request and expects
// it NOT refused. With --direct (only when a proxy such as Cloudflare sits in
// front, config/edge-firewall.ts "cloudflare"), also expects the host's own
// address to refuse an ordinary request. Prints one line per request, exits 1
// on any miss. Plain Node, no install needed; stdin is not read.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const payloads = JSON.parse(readFileSync(join(here, "..", "config", "edge-check-payloads.json"), "utf8"));
const REFUSED = new Set([403, 429]);

export function urlFor(base, p) {
  return `${base.replace(/\/+$/, "")}${p.path}${p.query ? `?${p.query}` : ""}`;
}

async function status(url, userAgent, fetchImpl) {
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": userAgent }, redirect: "manual" });
    return res.status;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Run the check; returns the number of misses. `fetchImpl` is injected by the tests.
 * @param {string} base
 * @param {{ direct?: string | null; fetchImpl?: (url: string, init: { headers: Record<string, string>; redirect: "manual" }) => Promise<{ status: number }>; print?: (line: string) => void }} [options]
 * @returns {Promise<number>}
 */
export async function edgeCheck(base, { direct = null, fetchImpl = fetch, print = console.log } = {}) {
  let misses = 0;
  for (const a of payloads.attacks) {
    const s = await status(urlFor(base, a), a.userAgent, fetchImpl);
    const ok = REFUSED.has(s);
    if (!ok) misses++;
    print(`${ok ? "ok  " : "MISS"} attack ${a.rule.padEnd(15)} ${s}  ${a.path}${a.query ? `?${a.query}` : ""}`);
  }
  for (const n of payloads.normal) {
    const s = await status(urlFor(base, n), n.userAgent, fetchImpl);
    const ok = typeof s === "number" && !REFUSED.has(s) && s < 500;
    if (!ok) misses++;
    print(`${ok ? "ok  " : "MISS"} normal ${String(s).padEnd(4)} ${n.path}${n.query ? `?${n.query}` : ""}`);
  }
  if (direct) {
    const s = await status(urlFor(direct, { path: "/", query: "" }), payloads.normal[0].userAgent, fetchImpl);
    const ok = REFUSED.has(s);
    if (!ok) misses++;
    print(`${ok ? "ok  " : "MISS"} direct host address refuses traffic that skipped the proxy: ${s}`);
  }
  print(misses ? `EDGE CHECK FAILED: ${misses} miss(es)` : "EDGE CHECK PASSED");
  return misses;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [base, flag, direct] = process.argv.slice(2);
  if (!base || (flag && flag !== "--direct")) {
    console.error("usage: node scripts/edge-check.mjs <production URL> [--direct <host URL>]");
    process.exit(64);
  }
  process.exit((await edgeCheck(base, { direct: flag ? direct : null })) ? 1 : 0);
}
