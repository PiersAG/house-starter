#!/usr/bin/env node
/**
 * Socket supply-chain report — ADVISORY ONLY.
 *
 * Reports what Socket knows about the dependencies this repo has added beyond
 * the trusted baseline. It NEVER fails: every exit path is 0, including a
 * missing key, a network error, a quota refusal and a schema surprise. Making
 * Socket a blocking gate is a CEO decision, not a config change (card 2.3.4).
 *
 * WHY IT IS NOT A GATE: Socket's alerts are heuristic supply-chain signals
 * (install scripts, network access, obfuscation, new maintainers). They are
 * useful for a human reading a PR and a poor fit for a hard fail — a false
 * positive would block every merge until someone with an account triaged it.
 * The deterministic gate is check-deps-existence.py, which runs alongside.
 *
 * SCOPE, deliberately narrow: only dependencies OUTSIDE
 * scripts/deps-baseline.json are sent — the same set check-deps-existence.py
 * evaluates. That keeps quota cost near-constant regardless of tree size, and
 * means we are not shipping the full dependency graph to a third party on
 * every push.
 *
 * Auth: `Authorization: Bearer <key>` (docs.socket.dev/reference/authentication).
 * Quota is checked first via GET /v0/quota, which itself costs 0 units, so a
 * run can never exhaust quota it did not have.
 */
import { readFileSync, existsSync } from "node:fs";

const API = "https://api.socket.dev/v0";
const KEY = process.env.SOCKET_API_KEY;

/** Every exit goes through here. Non-zero is not an option by design. */
function done(message) {
  console.log(message);
  process.exit(0);
}

function loadBaseline() {
  for (const p of ["scripts/deps-baseline.json", "agents/build/docker/deps-baseline.json"]) {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, "utf8"));
      return new Set(data.packages || data.baseline || []);
    }
  }
  return new Set();
}

async function main() {
  if (!KEY) {
    done(
      "socket: SOCKET_API_KEY not configured — skipping.\n" +
        "        This step is advisory; the deterministic supply-chain gate is\n" +
        "        the anti-slopsquatting check above, which does run.",
    );
  }

  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const baseline = loadBaseline();
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const outside = Object.entries(deps).filter(([name]) => !baseline.has(name));

  if (outside.length === 0) {
    done(`socket: no dependencies outside the ${baseline.size}-package baseline — nothing to report.`);
  }

  const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // Quota costs 0 units, so this can never itself exhaust the budget.
  try {
    const q = await fetch(`${API}/quota`, { headers });
    if (!q.ok) done(`socket: quota check returned ${q.status} — skipping (advisory).`);
    const { quota } = await q.json();
    console.log(`socket: quota remaining ${quota}`);
    if (typeof quota === "number" && quota < 100) {
      done("socket: insufficient quota for a batch lookup (needs 100 units) — skipping (advisory).");
    }
  } catch (err) {
    done(`socket: quota check failed (${err.message}) — skipping (advisory).`);
  }

  const components = outside.map(([name, version]) => ({
    purl: `pkg:npm/${name}@${String(version).replace(/^[\^~]/, "")}`,
  }));

  let artifacts;
  try {
    const res = await fetch(`${API}/purl?alerts=true&compact=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({ components }),
    });
    if (!res.ok) done(`socket: lookup returned ${res.status} — skipping (advisory).`);
    const text = await res.text();
    // The endpoint streams newline-delimited JSON objects.
    artifacts = text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    done(`socket: lookup failed (${err.message}) — skipping (advisory).`);
  }

  console.log(`socket: reviewed ${components.length} package(s) outside the baseline\n`);

  let flagged = 0;
  for (const a of artifacts) {
    const alerts = a.alerts || [];
    const notable = alerts.filter((x) => ["error", "warn"].includes(x.action));
    if (notable.length === 0) continue;
    flagged++;
    console.log(`  ${a.name}@${a.version}`);
    for (const alert of notable) {
      console.log(`    [${alert.action}] ${alert.type}${alert.severity ? ` (${alert.severity})` : ""}`);
    }
  }

  if (flagged === 0) {
    console.log("  no notable Socket alerts.");
  } else {
    console.log(
      `\nsocket: ${flagged} package(s) carry alerts. ADVISORY — this step does not fail the build.\n` +
        "        Review them in the PR; escalate to a gate only by CEO decision.",
    );
  }
  process.exit(0);
}

main().catch((err) => done(`socket: unexpected error (${err.message}) — advisory step, exiting 0.`));
