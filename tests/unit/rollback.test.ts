// @vitest-environment node
//
// The one-command rollback (app-business-core issue 793): it picks the previous
// production deployment, asks the host to roll back, and counts the rollback
// done only when the live health page reports the previous commit — timed
// against config/recovery.ts. The host is stubbed here; the first timed drill on
// a deployed app is the real-world proof.

import { describe, expect, it } from "vitest";
import { rollback, VERCEL_API } from "@/lib/rollback";

type Call = { url: string; method: string };

/** A stub host: three production deployments, the newest live; the rollback
 *  takes effect after `delayPolls` health readings. */
function host({ delayPolls = 2, refuseRollback = false, refuseList = false, deployments }: {
  delayPolls?: number;
  refuseRollback?: boolean;
  refuseList?: boolean;
  deployments?: unknown[];
} = {}) {
  const calls: Call[] = [];
  let serving = "c3";
  let rolledAt: number | null = null;
  let polls = 0;
  const list = deployments ?? [
    { uid: "dpl_3", url: "a-3.vercel.app", created: 3000, meta: { githubCommitSha: "c3" } },
    { uid: "dpl_1", url: "a-1.vercel.app", created: 1000, meta: { githubCommitSha: "c1" } },
    { uid: "dpl_2", url: "a-2.vercel.app", created: 2000, meta: { githubCommitSha: "c2" } },
  ];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith(`${VERCEL_API}/v6/deployments`)) {
      return refuseList ? new Response("no", { status: 403 }) : Response.json({ deployments: list });
    }
    if (url.includes("/rollback/")) {
      if (refuseRollback) return new Response("no", { status: 402 });
      rolledAt = polls;
      return Response.json({});
    }
    if (url.endsWith("/api/health")) {
      polls++;
      if (rolledAt !== null && polls - rolledAt > delayPolls) serving = "c2";
      return Response.json({ status: "ok", commit: serving });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function clock(stepMs: number) {
  let t = 0;
  return { now: () => (t += stepMs), sleep: async () => undefined };
}

const base = { token: "t", projectId: "prj_1", teamId: "team_1", appUrl: "https://app.example.com/" };

describe("rollback", () => {
  it("goes back to the previous production deployment and times the effect on the live address", async () => {
    const h = host();
    const r = await rollback({ ...base, fetchImpl: h.fetchImpl, ...clock(2000) });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.from?.id).toBe("dpl_3");
    expect(r.to?.id).toBe("dpl_2");
    expect(r.seconds).not.toBeNull();
    expect(r.within_target).toBe(true);
    const post = h.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${VERCEL_API}/v9/projects/prj_1/rollback/dpl_2?teamId=team_1`);
    expect(h.calls[0].url).toContain("projectId=prj_1&target=production&state=READY&limit=20&teamId=team_1");
  });

  it("reports a rollback slower than the target, and one that never takes effect", async () => {
    const slow = await rollback({ ...base, fetchImpl: host({ delayPolls: 4 }).fetchImpl, ...clock(20_000) });
    expect(slow.ok).toBe(false);
    expect(slow.within_target).toBe(false);
    expect(slow.problems.join("\n")).toMatch(/took .*s; the target is 60s/);

    const never = await rollback({ ...base, fetchImpl: host({ delayPolls: 1e9 }).fetchImpl, ...clock(30_000), timeoutMs: 120_000 });
    expect(never.ok).toBe(false);
    expect(never.problems.join("\n")).toMatch(/did not start serving the earlier version/);
  });

  it("changes nothing on a dry run, or when asked for an unknown deployment", async () => {
    const h = host();
    const dry = await rollback({ ...base, fetchImpl: h.fetchImpl, dryRun: true, ...clock(10) });
    expect(dry.ok).toBe(true);
    expect(dry.to?.id).toBe("dpl_2");
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);

    const unknown = await rollback({ ...base, fetchImpl: host().fetchImpl, toDeploymentId: "dpl_9", ...clock(10) });
    expect(unknown.ok).toBe(false);
    expect(unknown.problems[0]).toMatch(/dpl_9 is not a ready production deployment/);

    const chosen = await rollback({ ...base, fetchImpl: host().fetchImpl, toDeploymentId: "dpl_1", dryRun: true, ...clock(10) });
    expect(chosen.to?.id).toBe("dpl_1");
  });

  it("fails plainly when the host refuses, or there is nothing earlier to go back to", async () => {
    const list = await rollback({ ...base, fetchImpl: host({ refuseList: true }).fetchImpl, ...clock(10) });
    expect(list.problems).toEqual(["the host refused the deployment list (HTTP 403)"]);

    const refused = await rollback({ ...base, fetchImpl: host({ refuseRollback: true }).fetchImpl, ...clock(10) });
    expect(refused.ok).toBe(false);
    expect(refused.problems[0]).toMatch(/refused the rollback \(HTTP 402\)/);

    const only = await rollback({
      ...base,
      teamId: undefined,
      fetchImpl: host({ deployments: [{ id: "dpl_x", url: "x", createdAt: 5, meta: { githubCommitSha: "c3" } }] }).fetchImpl,
      ...clock(10),
    });
    expect(only.problems).toEqual(["there is no earlier ready production deployment to go back to"]);

    const noCommit = await rollback({
      ...base,
      fetchImpl: host({
        deployments: [
          { uid: "dpl_3", created: 3, meta: { githubCommitSha: "c3" } },
          { uid: "dpl_2", created: 2 },
        ],
      }).fetchImpl,
      ...clock(10),
    });
    expect(noCommit.ok).toBe(false);
    expect(noCommit.problems[0]).toMatch(/no recorded commit/);
  });

  it("treats an unreachable health page as not yet rolled back", async () => {
    let n = 0;
    const flaky = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) {
        n++;
        if (n === 1) return Response.json({ commit: "c3" });
        if (n === 2) throw new Error("connection reset");
        if (n === 3) return new Response("down", { status: 502 });
        return Response.json({ commit: "c2" });
      }
      return host().fetchImpl(input, init);
    }) as typeof fetch;
    const r = await rollback({ ...base, fetchImpl: flaky, ...clock(1000) });
    expect(r.ok).toBe(true);
  });
});
