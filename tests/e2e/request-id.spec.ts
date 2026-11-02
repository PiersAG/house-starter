// The request id the edge middleware sets (issue 503): on every response —
// pages and redirects too, not only API routes — fresh each time, and never the
// id a caller sent. Request-only: runs without a browser. Applied with the
// middleware edit by the dispatch AC CEO script (the safety gate protects
// middleware).

import { test, expect } from "@playwright/test";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a page, a redirect and an API answer each carry a fresh request id", async ({ request }) => {
  const page = await request.get("/login", { maxRedirects: 0 });
  const redirect = await request.get("/dashboard", { maxRedirects: 0 });
  const api = await request.get("/api/health");
  const ids = [page, redirect, api].map((r) => r.headers()["x-request-id"]);
  for (const id of ids) expect(id).toMatch(ID);
  expect(new Set(ids).size).toBe(3);
});

test("a caller-sent request id is replaced, never trusted", async ({ request }) => {
  const sent = "00000000-0000-4000-8000-000000000000";
  const res = await request.get("/api/health", { headers: { "x-request-id": sent } });
  expect(res.headers()["x-request-id"]).toMatch(ID);
  expect(res.headers()["x-request-id"]).not.toBe(sent);
});
