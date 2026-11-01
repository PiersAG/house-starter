// Server-side request forgery, API exposure and internal-network trust
// (app-business-core issue 448, SEC.31; Matt Murphy #13, #29, #69), and
// tenant-scoped cache keys (issue 521; Matt Murphy #113).

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_REDIRECTS,
  OutboundFetchError,
  addressProblem,
  fetchUserUrl,
  isBlockedAddress,
} from "@/lib/outbound-fetch";
import { MissingTenantKeyError, tenantCacheKey, tenantCacheKeyParts } from "@/lib/cache-key";

const ALLOW = ["example.com"];
const PUBLIC = [{ address: "93.184.215.14", family: 4 }];

function harness(answers: Record<string, { status: number; location?: string; body?: string }>, dns: Record<string, { address: string; family: number }[]> = {}) {
  const logs: Record<string, string | number>[] = [];
  const connected: string[] = [];
  return {
    logs,
    connected,
    options: {
      allowHosts: ALLOW,
      log: (d: Record<string, string | number>) => logs.push(d),
      resolve: async (h: string) => dns[h] ?? PUBLIC,
      get: async (url: URL, address: string) => {
        connected.push(`${url.hostname}@${address}`);
        const a = answers[url.toString()];
        if (!a) throw new Error("no such answer");
        return { status: a.status, location: a.location, body: a.body ?? "" };
      },
    },
  };
}

describe("internal and metadata addresses are never fetched", () => {
  it("blocks loopback, private, link-local, metadata, CGNAT, unique-local and multicast", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it("refuses non-https, other ports, credentials, IP literals and hosts off the allow-list", () => {
    expect(addressProblem("https://example.com/x", ALLOW)).toBeNull();
    expect(addressProblem("https://img.example.com/x", ALLOW)).toBeNull();
    for (const bad of [
      "http://example.com/",
      "file:///etc/passwd",
      "gopher://example.com/",
      "https://example.com:8443/",
      "https://user:pw@example.com/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://127.0.0.1/",
      "https://evil.com/",
      "https://example.com.evil.com/",
      "https://notexample.com/",
      "not a url",
    ]) {
      expect(addressProblem(bad, ALLOW), bad).not.toBeNull();
    }
  });
});

describe("fetchUserUrl", () => {
  it("fetches an allowed public address, connecting to the address it checked", async () => {
    const h = harness({ "https://example.com/a": { status: 200, body: "ok" } });
    await expect(fetchUserUrl("https://example.com/a", h.options)).resolves.toBe("ok");
    expect(h.connected).toEqual(["example.com@93.184.215.14"]);
  });

  it("refuses a host that resolves to an internal address (DNS rebinding)", async () => {
    const h = harness({}, { "example.com": [{ address: "169.254.169.254", family: 4 }] });
    await expect(fetchUserUrl("https://example.com/a", h.options)).rejects.toBeInstanceOf(OutboundFetchError);
    expect(h.connected).toEqual([]);
    expect(h.logs[0].reason).toBe("resolves to an internal address");
  });

  it("refuses if ANY resolved address is internal", async () => {
    const h = harness({}, { "example.com": [PUBLIC[0], { address: "10.0.0.5", family: 4 }] });
    await expect(fetchUserUrl("https://example.com/a", h.options)).rejects.toBeInstanceOf(OutboundFetchError);
  });

  it("re-checks every redirect: one to an internal or off-list address is refused", async () => {
    for (const location of ["https://169.254.169.254/latest/meta-data/", "http://example.com/x", "https://evil.com/x", "https://inner.example.com/x"]) {
      const h = harness(
        { "https://example.com/a": { status: 302, location } },
        { "inner.example.com": [{ address: "192.168.0.10", family: 4 }] },
      );
      await expect(fetchUserUrl("https://example.com/a", h.options), location).rejects.toBeInstanceOf(OutboundFetchError);
      expect(h.connected).toEqual(["example.com@93.184.215.14"]);
    }
  });

  it("follows an allowed redirect, and stops after the limit", async () => {
    const ok = harness({
      "https://example.com/a": { status: 301, location: "/b" },
      "https://example.com/b": { status: 200, body: "moved" },
    });
    await expect(fetchUserUrl("https://example.com/a", ok.options)).resolves.toBe("moved");

    const loop = harness({ "https://example.com/a": { status: 302, location: "/a" } });
    await expect(fetchUserUrl("https://example.com/a", loop.options)).rejects.toBeInstanceOf(OutboundFetchError);
    expect(loop.connected).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("every failure is the same generic error; the detail goes only to the server log", async () => {
    const messages = new Set<string>();
    for (const url of ["https://evil.com/", "https://example.com/missing", "http://example.com/"]) {
      const h = harness({});
      const err = await fetchUserUrl(url, h.options).catch((e) => e);
      expect(err).toBeInstanceOf(OutboundFetchError);
      messages.add(err.message);
      expect(h.logs.length).toBe(1);
      expect(String(h.logs[0].reason).length).toBeGreaterThan(3);
    }
    expect([...messages]).toEqual(["We could not fetch that address."]);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("no API documentation or schema is published (Matt Murphy #29)", () => {
  it("no route serves API docs, an OpenAPI/Swagger schema or GraphQL introspection", () => {
    const routes = files("app").filter((f) => /\/(route\.ts|page\.tsx)$/.test(f));
    for (const f of routes) {
      expect(f, "API documentation must stay with the team, not on a public route").not.toMatch(
        /(swagger|openapi|api-docs|redoc|graphql|graphiql|\/docs\/)/i,
      );
    }
    for (const f of [...files("app"), ...files("lib")]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/introspection\s*:\s*true/);
    }
  });
});

describe("nothing is trusted because it comes from the internal network (Matt Murphy #13)", () => {
  it("no code compares a client address with an internal range to decide access", () => {
    const internal = /["'](10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|localhost)/;
    const clientAddress = /(x-forwarded-for|x-real-ip|\.ip\b|remoteAddress|cf-connecting-ip)/i;
    const offenders = [...files("app"), ...files("lib"), "middleware.ts"].filter((f) => {
      if (f === "lib/outbound-fetch.ts") return false; // blocks internal addresses, never trusts them
      const src = readFileSync(f, "utf8");
      return src.split("\n").some((line) => internal.test(line) && clientAddress.test(line));
    });
    expect(offenders).toEqual([]);
  });
});

describe("cache keys always carry the tenant (issue 521)", () => {
  it("builds tenant-first keys", () => {
    expect(tenantCacheKey("t1", "dashboard", "summary")).toBe("tenant:t1:dashboard:summary");
    expect(tenantCacheKeyParts("t1", "x")).toEqual(["tenant", "t1", "x"]);
  });

  it("refuses a key with no tenant, and a part that tries to smuggle one in", () => {
    for (const t of [null, undefined, "", "a:b"]) expect(() => tenantCacheKey(t, "x")).toThrow(MissingTenantKeyError);
    expect(() => tenantCacheKey("t1", "x:tenant:t2")).toThrow();
    expect(() => tenantCacheKey("t1", "")).toThrow();
  });
});
