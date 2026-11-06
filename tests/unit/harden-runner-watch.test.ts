// Outbound-network watch on every job (app-business-core #895; Matt Murphy, #756 rows
// R0068 and R0526: "network egress controls" on agents and their containers).
//
// CEO ruling 2026-11-04, option A in watch-only mode: StepSecurity Harden-Runner is the
// FIRST step of every job that runs steps, pinned by commit, with `egress-policy: audit`
// — it records every outbound connection the job makes and blocks none. Free on a
// public repository. Paid cover for the private factory repository is decided at the
// K9Coach rebuild (#846).
//
// Held here: a job added later without it, a second copy pinned differently, or a switch
// to blocking mode (which would need its own ruling and an allow-list) all fail.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", "..", ".github", "workflows");
const PIN = "step-security/harden-runner@46b06cea07f9e64621fdf066ba77ac6915163d43";

type Job = { file: string; id: string; body: string };

function jobs(): Job[] {
  const out: Job[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
    const text = readFileSync(join(DIR, file), "utf8");
    const at = text.indexOf("\njobs:\n");
    if (at === -1) continue;
    const block = text.slice(at + "\njobs:\n".length);
    const heads = [...block.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
    heads.forEach((m, i) => {
      const end = i + 1 < heads.length ? heads[i + 1].index : block.length;
      out.push({ file, id: m[1], body: block.slice(m.index, end) });
    });
  }
  return out;
}

const withSteps = jobs().filter((j) => /^ {4}steps:\s*$/m.test(j.body));

describe("Harden-Runner watches every job's outbound traffic (#895)", () => {
  it("finds the jobs", () => {
    expect(withSteps.length).toBeGreaterThanOrEqual(5);
  });

  it.each(withSteps.map((j) => [`${j.file} · ${j.id}`, j]))(
    "%s starts with it, pinned, in watch-only mode",
    (_label, j) => {
      const job = j as Job;
      const steps = job.body.slice(job.body.search(/^ {4}steps:\s*$/m));
      const first = steps.split(/\n {6}- /)[1] ?? "";
      expect(first).toContain(`uses: ${PIN}`);
      expect(first).toMatch(/egress-policy: audit/);
      expect(first).not.toMatch(/egress-policy: block/);
    },
  );

  it("is pinned the same way everywhere", () => {
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".yml"))) {
      const text = readFileSync(join(DIR, file), "utf8");
      for (const m of text.matchAll(/step-security\/harden-runner@([^\s#]+)/g)) {
        expect(`step-security/harden-runner@${m[1]}`).toBe(PIN);
      }
    }
  });
});
