// @vitest-environment node
//
// The off-provider copy's hidden switch, in both states (capability model: every
// switch tested ON and OFF; app-business-core issue 528). ON in every build;
// OFF refuses loudly and writes nothing — it never pretends to have backed up.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOffProviderCopyEnabled, offProviderCopy, recoveryTargets, backupPolicy } from "@/config/recovery";
import { BackupSwitchedOffError, exportAll } from "@/lib/backup/export";
import { seedApp, tenantsOf } from "./backup-seed";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "switch-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("off-provider copy switch", () => {
  it("is ON in the build, as a hidden switch", () => {
    expect(offProviderCopy.enabled).toBe(true);
    expect(isOffProviderCopyEnabled()).toBe(true);
  });

  it("ON: the export runs", async () => {
    const catalogUrl = await seedApp(dir, ["t_one"]);
    const m = await exportAll({
      app: "proof",
      catalog: { url: catalogUrl },
      outDir: join(dir, "on"),
      listTenants: () => tenantsOf(catalogUrl),
      switchConfig: { enabled: true },
    });
    expect(m.databases).toHaveLength(2);
    expect(existsSync(join(dir, "on", "manifest.json"))).toBe(true);
  });

  it("OFF: the export refuses and writes nothing", async () => {
    const catalogUrl = await seedApp(dir, ["t_one"]);
    await expect(
      exportAll({
        app: "proof",
        catalog: { url: catalogUrl },
        outDir: join(dir, "off"),
        listTenants: () => tenantsOf(catalogUrl),
        switchConfig: { enabled: false },
      }),
    ).rejects.toBeInstanceOf(BackupSwitchedOffError);
    expect(existsSync(join(dir, "off"))).toBe(false);
    expect(isOffProviderCopyEnabled({ enabled: false })).toBe(false);
  });

  it("carries the recommended targets and policy", () => {
    expect(recoveryTargets).toEqual({
      rtoMinutes: 240,
      rpoProviderLostMinutes: 1440,
      rpoProviderAvailableMinutes: 15,
      rollbackSeconds: 60,
      rollbackAimSeconds: 30,
    });
    expect(backupPolicy).toEqual({ retentionDays: 30, drillCadence: "monthly", exportCadence: "nightly" });
  });
});
