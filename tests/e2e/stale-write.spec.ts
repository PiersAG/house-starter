// Stale writes are refused over HTTP (app-business-core issue 536). Two screens
// showing the same version of a setting: the first save succeeds, the second —
// based on a version that is no longer current — gets 409 and does not
// overwrite it; a save based on the current version succeeds.

import { expect, test } from "@playwright/test";
import { client, ensureAccount, signIn, writeHeaders } from "./session-helpers";

test("a stale second write gets 409; the current-version write succeeds", async () => {
  const a = await client("203.0.113.91");
  const email = `stale-${Date.now()}@example.com`;
  await ensureAccount(a, email);
  await signIn(a, email);
  const url = "/api/settings/core.client_self_registration";
  const headers = await writeHeaders(a);

  const first = await a.put(url, { data: { value: true, version: 0 }, headers });
  expect(first.status(), await first.text()).toBe(200);
  const v1 = ((await first.json()) as { version: number }).version;
  expect(v1).toBe(1);

  const deviceA = await a.put(url, { data: { value: false, version: v1 }, headers });
  expect(deviceA.status()).toBe(200);
  const deviceB = await a.put(url, { data: { value: true, version: v1 }, headers });
  expect(deviceB.status()).toBe(409);
  expect(((await deviceB.json()) as { version: number }).version).toBe(2);

  const retry = await a.put(url, { data: { value: true, version: 2 }, headers });
  expect(retry.status()).toBe(200);
  expect(((await retry.json()) as { version: number }).version).toBe(3);

  const malformed = await a.put(url, { data: { value: true, version: "2; DROP TABLE x" }, headers });
  expect(malformed.status()).toBe(400);
});
