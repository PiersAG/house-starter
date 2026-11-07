// The slowest connection and an old phone's processor (app-business-core issue 721;
// Matt Murphy #296: "test on the this device you can find with the slowest connection
// the smallest screen the oldest browser"; #323: "a phone from 2019").
//
// A project with `metadata.slow` (playwright.config.ts) runs every page over Chrome
// DevTools' "Slow 3G" profile — 2 seconds of latency, about 50 KB a second each way —
// with the processor slowed four times, the profile Chrome's own tools use for a
// low-end phone. Both are applied through Chromium's DevTools protocol, which only
// Chromium has, so the slow projects are Chromium-based (a 2019 Pixel 4, and 320 px).

import type { Page, TestInfo } from "@playwright/test";

export const SLOW_3G = {
  offline: false,
  latency: 2000,
  downloadThroughput: 50_000,
  uploadThroughput: 50_000,
} as const;
export const CPU_SLOWDOWN = 4;

export function isSlowProject(testInfo: TestInfo): boolean {
  return Boolean((testInfo.project.metadata as { slow?: boolean } | undefined)?.slow);
}

/** Apply the slow connection and slowed processor to this page, when the project asks. */
export async function applySlowDevice(page: Page, testInfo: TestInfo): Promise<boolean> {
  if (!isSlowProject(testInfo)) return false;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", SLOW_3G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  return true;
}
