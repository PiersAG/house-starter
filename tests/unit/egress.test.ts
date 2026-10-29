// Outbound network access by need (#756). The guard sits on every TCP
// connection the process opens, so these tests open real sockets: an allowed
// host (a server on this machine) connects; a host not on the list is refused
// before any address lookup, so no network is needed.

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EgressBlockedError,
  __uninstallEgressGuardForTests,
  allowList,
  egressPolicy,
  installEgressGuard,
  isAllowed,
} from "@/lib/egress";

const env = (o: Record<string, string>) => ({ NODE_ENV: "test", ...o }) as NodeJS.ProcessEnv;

afterEach(() => __uninstallEgressGuardForTests());

function tryConnect(opts: net.NetConnectOpts): Promise<"connected" | Error> {
  return new Promise((resolve) => {
    const s = net.connect(opts);
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.once("error", (e) => resolve(e));
  });
}

async function localServer(): Promise<{ port: number; close: () => void }> {
  const srv = net.createServer((c) => c.end());
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as net.AddressInfo).port, close: () => srv.close() };
}

describe("egressPolicy", () => {
  it("enforces on a deployed instance and is off locally", () => {
    expect(egressPolicy(env({ VERCEL_ENV: "production" }))).toBe("enforce");
    expect(egressPolicy(env({ VERCEL_ENV: "preview" }))).toBe("enforce");
    expect(egressPolicy(env({}))).toBe("off");
  });
  it("takes an explicit setting and rejects anything else", () => {
    expect(egressPolicy(env({ VERCEL_ENV: "production", EGRESS_POLICY: "report" }))).toBe("report");
    expect(egressPolicy(env({ EGRESS_POLICY: "enforce" }))).toBe("enforce");
    expect(() => egressPolicy(env({ EGRESS_POLICY: "allow-all" }))).toThrow(/EGRESS_POLICY/);
  });
});

describe("the allow-list", () => {
  const list = allowList(
    env({
      VERCEL_URL: "myapp-abc123.vercel.app",
      DATABASE_URL: "libsql://catalog-myorg.aws-eu-west-1.turso.io",
      RATE_LIMIT_STORE_URL: "https://eu1-fine-cat-12345.upstash.io",
      EGRESS_ALLOW: "hooks.example.test, https://api.partner.example/v1",
    }),
  );
  it("allows the services the template uses", () => {
    for (const h of ["api.turso.tech", "api.stripe.com", "api.resend.com", "secretsmanager.eu-west-2.amazonaws.com"]) {
      expect(isAllowed(h, list), h).toBe(true);
    }
  });
  it("allows every database under turso.io, the app's own address, its store and EGRESS_ALLOW", () => {
    expect(isAllowed("t0123-myorg.aws-eu-west-1.turso.io", list)).toBe(true);
    expect(isAllowed("myapp-abc123.vercel.app", list)).toBe(true);
    expect(isAllowed("eu1-fine-cat-12345.upstash.io", list)).toBe(true);
    expect(isAllowed("hooks.example.test", list)).toBe(true);
    expect(isAllowed("api.partner.example", list)).toBe(true);
  });
  it("refuses everything else, including look-alikes", () => {
    for (const h of [
      "evil.example",
      "other-app.vercel.app",
      "api.stripe.com.evil.example",
      "turso.io.evil.example",
      "notturso.io",
      "upstash.io",
    ]) {
      expect(isAllowed(h, list), h).toBe(false);
    }
  });
});

describe("installEgressGuard", () => {
  it("enforce: refuses a host not on the list, naming it, and logs the refusal", async () => {
    const lines: string[] = [];
    installEgressGuard(env({ EGRESS_POLICY: "enforce" }), (l) => lines.push(l));
    const r = await tryConnect({ host: "exfil.example.invalid", port: 443 });
    expect(r).toBeInstanceOf(EgressBlockedError);
    expect((r as Error).message).toMatch(/exfil\.example\.invalid.*egress-allow\.json/);
    expect(lines).toEqual(["[egress] refused exfil.example.invalid"]);
  });

  it("enforce: refuses fetch to a host not on the list", async () => {
    installEgressGuard(env({ EGRESS_POLICY: "enforce" }), () => {});
    const err = await fetch("http://exfil.example.invalid/steal").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(EgressBlockedError);
  });

  it("enforce: still connects to an allowed host", async () => {
    const srv = await localServer();
    try {
      installEgressGuard(env({ EGRESS_POLICY: "enforce" }), () => {});
      expect(await tryConnect({ host: "127.0.0.1", port: srv.port })).toBe("connected");
      expect(await tryConnect({ port: srv.port })).toBe("connected"); // no host = localhost
    } finally {
      srv.close();
    }
  });

  it("report: lets the connection try, and logs the host once", async () => {
    const lines: string[] = [];
    installEgressGuard(env({ EGRESS_POLICY: "report" }), (l) => lines.push(l));
    const r1 = await tryConnect({ host: "not-allowed.invalid", port: 9 });
    const r2 = await tryConnect({ host: "not-allowed.invalid", port: 9 });
    // the lookup itself fails (.invalid never resolves) — but not by the guard
    expect(r1).not.toBeInstanceOf(EgressBlockedError);
    expect(r2).not.toBeInstanceOf(EgressBlockedError);
    expect(lines).toEqual(["[egress] would refuse not-allowed.invalid (EGRESS_POLICY=report)"]);
  });

  it("off: no check at all", async () => {
    expect(installEgressGuard(env({}), () => {})).toBe("off");
    const r = await tryConnect({ host: "not-allowed.invalid", port: 9 });
    expect(r).not.toBeInstanceOf(EgressBlockedError);
  });
});

describe("installEgressGuard — every way a connection can be asked for", () => {
  it("reads the host from (port, host), (port), an options object, and lets local sockets through", async () => {
    const srv = await localServer();
    const os = await import("node:os");
    const path = await import("node:path");
    const sock = path.join(os.tmpdir(), `hs-egress-${process.pid}-${Date.now()}.sock`);
    const ipc = net.createServer((c) => c.end());
    await new Promise<void>((r) => ipc.listen(sock, r));
    try {
      installEgressGuard(env({ EGRESS_POLICY: "enforce" }), () => {});
      const viaSocket = (...args: unknown[]) =>
        new Promise<"connected" | Error>((resolve) => {
          const s = new net.Socket();
          s.once("connect", () => {
            s.destroy();
            resolve("connected");
          });
          s.once("error", (e) => resolve(e));
          (s.connect as unknown as (...a: unknown[]) => void)(...args);
        });
      expect(await viaSocket(srv.port, "127.0.0.1")).toBe("connected");
      expect(await viaSocket(srv.port)).toBe("connected");
      expect(await viaSocket(9, "blocked.invalid")).toBeInstanceOf(EgressBlockedError);
      expect(await viaSocket({ port: srv.port, host: "" })).toBe("connected");
      expect(await viaSocket(sock)).toBe("connected");
      expect(await viaSocket({ path: sock })).toBe("connected");
    } finally {
      srv.close();
      ipc.close();
    }
  });

  it("ignores an address in the environment that is not a URL", () => {
    const list = allowList(env({ APP_URL: "http://[not a host" }));
    expect(isAllowed("not a host", list)).toBe(false);
  });

  it("logs through console.warn by default, and installing twice keeps one guard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installEgressGuard(env({ EGRESS_POLICY: "enforce" }));
    installEgressGuard(env({ EGRESS_POLICY: "enforce" }));
    await tryConnect({ host: "twice.invalid", port: 9 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[egress] refused twice.invalid");
  });
});
