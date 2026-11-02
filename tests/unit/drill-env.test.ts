// @vitest-environment node
//
// The drilled app is started with drill-only values and nothing else from the job:
// no cloud key, no GitHub sign-in value, no database token reaches it
// (app-business-core #528 review, finding 2). drillEnv is an allow-list.

import { describe, expect, it } from "vitest";
import { DRILL_ENV_PASSTHROUGH, drillEnv } from "@/lib/backup/boot";
import type { RestoreResult } from "@/lib/backup/restore";

const restored = { catalogUrl: "file:restored.db", manifest: { tenancy: "per_tenant" } } as RestoreResult;

const job: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/runner",
  TMPDIR: "/tmp",
  AWS_ACCESS_KEY_ID: "drill-test-not-a-key",
  AWS_SECRET_ACCESS_KEY: "drill-test-not-a-key",
  AWS_SESSION_TOKEN: "drill-test-not-a-key",
  GITHUB_TOKEN: "drill-test-not-a-key",
  GH_TOKEN: "drill-test-not-a-key",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "drill-test-not-a-key",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
  ACTIONS_RUNTIME_TOKEN: "drill-test-not-a-key",
  TURSO_API_TOKEN: "drill-test-not-a-key",
  DB_READ_TOKEN: "drill-test-not-a-key",
  CATALOG_DATABASE_AUTH_TOKEN: "drill-test-not-a-key",
  SOME_LATER_VALUE: "drill-test-not-a-key",
};

describe("drill environment", () => {
  it("passes only the allow-listed values from the job, and the drill-only ones", () => {
    const env = drillEnv(restored, 3100, job);
    for (const k of Object.keys(job)) {
      if ((DRILL_ENV_PASSTHROUGH as readonly string[]).includes(k)) expect(env[k]).toBe(job[k]);
      else expect(env[k], `${k} must not reach the drilled app`).toBeUndefined();
    }
    expect(Object.keys(env).some((k) => /^(AWS_|GITHUB_|ACTIONS_|GH_)/.test(k))).toBe(false);
    expect(env.CATALOG_DATABASE_URL).toBe("file:restored.db");
    expect(env.PORT).toBe("3100");
  });

  it("reads process.env by default, still through the allow-list", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "drill-test-not-a-key";
    try {
      const env = drillEnv(restored, 3100);
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });
});
