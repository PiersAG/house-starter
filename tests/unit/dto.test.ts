// @vitest-environment node
//
// lib/dto.ts — the one way data leaves the server for the browser
// (app-business-core issues 794, 763, 445): only the named fields cross, at
// every depth; a value missing a named field is refused; an answer built from
// a DTO is never stored.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NO_STORE, defineDto, dtoJson } from "@/lib/dto";

const ROW = {
  id: "u1",
  email: "owner@example.com",
  passwordHash: "$2b$10$abcdefghijklmnopqrstuv",
  workspace: { id: "t1", label: "Mine", dbAuthToken: "sealed" },
};

const Me = defineDto({
  id: z.string(),
  email: z.string(),
  workspace: z.object({ id: z.string(), label: z.string() }),
});

describe("defineDto", () => {
  it("keeps the named fields and drops every other one, nested ones included", () => {
    expect(Me.from(ROW)).toEqual({ id: "u1", email: "owner@example.com", workspace: { id: "t1", label: "Mine" } });
    expect(JSON.stringify(Me.from(ROW))).not.toMatch(/passwordHash|dbAuthToken/);
  });

  it("refuses a value missing a named field", () => {
    expect(() => Me.from({ id: "u1" })).toThrow();
  });
});

describe("dtoJson", () => {
  it("answers with only the DTO's fields, marked no-store", async () => {
    const res = dtoJson(Me, ROW);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE["Cache-Control"]);
    expect(await res.json()).toEqual(Me.from(ROW));
  });

  it("keeps a status and the caller's own cache header", async () => {
    const res = dtoJson(Me, ROW, { status: 201, headers: { "Cache-Control": "private, max-age=0" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("private, max-age=0");
  });
});
