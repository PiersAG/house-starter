// Recovery targets and the off-provider copy switch (app-business-core issues
// 345, 528, 752, 793; docs/recovery.md is the runbook).
//
// TARGETS ARE BUSINESS DECISIONS. How long recovery may take (RTO) and how much
// recent data may be lost (RPO) are set by the CEO from what the business can
// bear, not from what the infrastructure happens to do (Matt Murphy #88: "define
// both based on your business requirements not your infrastructure defaults").
// The CEO set the values below on 2026-11-02 (app-business-core wiki/decisions.md,
// "Recovery targets (#752)"); the monthly restore drill (lib/backup/drill.ts) and the
// rollback drill (lib/rollback.ts) measure every run against them and fail when
// a run misses one.
//
// THE SWITCH. `offProviderCopy.enabled` is a HIDDEN switch, like the kernel's
// (config/kernel.ts): ON in every automated build, flipped only by hand by the
// CEO for an edge case the factory does not model. It is not a capability —
// there is no page or route to switch off — and it is never an environment
// variable. OFF makes the nightly export refuse to run, loudly; it never makes it
// pretend to succeed. Both states are tested (tests/unit/recovery-switch.test.ts).

export interface RecoveryTargets {
  /** Longest acceptable time to bring every customer's data back from the
   *  off-provider copy and have the app serving again, in minutes. */
  rtoMinutes: number;
  /** Most recent data that may be lost when the database provider itself is
   *  lost and the nightly off-provider copy is the newest copy, in minutes. */
  rpoProviderLostMinutes: number;
  /** Most recent data that may be lost when the provider is fine and its own
   *  point-in-time restore is used (a bad change, an accidental deletion). */
  rpoProviderAvailableMinutes: number;
  /** A bad deploy is rolled back and the previous version is serving within
   *  this many seconds of the one rollback command (Matt Murphy #307). */
  rollbackSeconds: number;
  /** What the rollback aims for (Matt Murphy #287: "in 30 seconds"). Reported,
   *  not failed on. */
  rollbackAimSeconds: number;
}

export const recoveryTargets: RecoveryTargets = {
  rtoMinutes: 240,
  rpoProviderLostMinutes: 24 * 60,
  rpoProviderAvailableMinutes: 15,
  rollbackSeconds: 60,
  rollbackAimSeconds: 30,
};

export interface BackupPolicy {
  /** Every export is locked against change and deletion for this many days,
   *  then expires (issue 528: "30-day retention"). */
  retentionDays: number;
  /** Matt Murphy #182: "restore to a test environment once a month minimum". The
   *  timed drill runs monthly, which also meets the quarterly cadence of #88 and
   *  #200. */
  drillCadence: "monthly";
  exportCadence: "nightly";
}

export const backupPolicy: BackupPolicy = {
  retentionDays: 30,
  drillCadence: "monthly",
  exportCadence: "nightly",
};

export const offProviderCopy: { enabled: boolean } = {
  enabled: true,
};

/** The one place the switch is read, so a test can flip it. */
export function isOffProviderCopyEnabled(config: { enabled: boolean } = offProviderCopy): boolean {
  return config.enabled === true;
}
