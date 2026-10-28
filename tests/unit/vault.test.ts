// @vitest-environment node
// lib/vault.ts — the one "get key" layer (#822 Step 5), twin of the factory's
// dashboard/lib/vault.test.mjs. Both states: a migrated key with the test vault
// returns its value; absent / refused / empty → VaultError and never process.env.
// Stored-copy keys behave as today; unknown names are refused; nothing but
// lib/vault.ts may import the AWS SDK.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AwsVault,
  FakeVault,
  getKey,
  isVaultError,
  setVaultForTests,
  VAULT_ROLE_ENV,
  VaultError,
  vaultUnavailable,
  type Layer,
} from "@/lib/vault";
import layerFile from "@/lib/vault-layer.json";

const SECRET = "s3cr3t-value-" + "x".repeat(8);
const OLD = "old-value-" + "y".repeat(8);
const LAYER: Layer = {
  MOVED_KEY: { vault: "app/demo/MOVED_KEY", status: "migrated" },
  NAMELESS_KEY: { vault: null, status: "migrated" },
  WAITING_KEY: { vault: "app/demo/WAITING_KEY", status: "pending" },
  KEPT_OUT: { vault: null, status: "exception" },
};
const ENV_NAMES = [
  "MOVED_KEY",
  "NAMELESS_KEY",
  "WAITING_KEY",
  "KEPT_OUT",
  "WAITING_KEY_PREVIOUS",
  "NOT_REGISTERED",
  "VAULT_BACKEND",
  "VERCEL_ENV",
  VAULT_ROLE_ENV,
];
const saved: Record<string, string | undefined> = {};

function notEchoing(...values: string[]) {
  return (e: unknown) =>
    e instanceof VaultError && values.every((v) => !e.message.includes(v));
}

beforeEach(() => {
  for (const n of ENV_NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  process.env.VAULT_BACKEND = "fake";
  setVaultForTests(null, LAYER);
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const n of ENV_NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  setVaultForTests(null);
  vi.restoreAllMocks();
});

describe("migrated key (vault only)", () => {
  it("comes from the vault", async () => {
    setVaultForTests(new FakeVault({ "app/demo/MOVED_KEY": SECRET }), LAYER);
    expect(await getKey("MOVED_KEY")).toBe(SECRET);
  });

  it("reads the previous version", async () => {
    setVaultForTests(
      new FakeVault({
        "app/demo/MOVED_KEY": { current: SECRET, previous: OLD },
      }),
      LAYER,
    );
    expect(await getKey("MOVED_KEY", { version: "previous" })).toBe(OLD);
  });

  it("has no previous version when only one value is stored", async () => {
    setVaultForTests(new FakeVault({ "app/demo/MOVED_KEY": SECRET }), LAYER);
    await expect(getKey("MOVED_KEY", { version: "previous" })).rejects.toThrow(
      /no previous value/,
    );
  });

  it.each([
    ["absent", {}],
    ["empty", { "app/demo/MOVED_KEY": "" }],
  ])("%s → throws and never uses process.env", async (_label, values) => {
    process.env.MOVED_KEY = OLD;
    setVaultForTests(new FakeVault(values), LAYER);
    await expect(getKey("MOVED_KEY")).rejects.toSatisfy(notEchoing(OLD));
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /MOVED_KEY could not be read from the vault/,
    );
  });

  it("no test vault installed → throws, never process.env", async () => {
    process.env.MOVED_KEY = OLD;
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /no test vault is installed/,
    );
  });

  it("a register entry with no vault name → throws", async () => {
    process.env.NAMELESS_KEY = OLD;
    setVaultForTests(new FakeVault({}), LAYER);
    await expect(getKey("NAMELESS_KEY")).rejects.toThrow(
      /gives it no vault name/,
    );
  });

  it("a refused read throws with a plain reason", async () => {
    setVaultForTests(
      {
        read: async () => {
          throw new VaultError("this deployment's role may not read it");
        },
      },
      LAYER,
    );
    await expect(getKey("MOVED_KEY")).rejects.toThrow(/may not read it/);
  });

  it("a non-vault error from the backend is not echoed", async () => {
    setVaultForTests(
      {
        read: async () => {
          throw new Error(`boom ${SECRET}`);
        },
      },
      LAYER,
    );
    await expect(getKey("MOVED_KEY")).rejects.toSatisfy(notEchoing(SECRET));
    await expect(getKey("MOVED_KEY")).rejects.toThrow(/could not be reached/);
  });

  it("names the deployment in the error", async () => {
    process.env.VERCEL_ENV = "production";
    setVaultForTests(new FakeVault({}), LAYER);
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /by the app \(production\)/,
    );
  });

  it("caches a read for five minutes and logs it once", async () => {
    const read = vi.fn(async () => ({ value: SECRET, versionId: "v1" }));
    setVaultForTests({ read }, LAYER);
    vi.useFakeTimers();
    try {
      expect(await getKey("MOVED_KEY")).toBe(SECRET);
      expect(await getKey("MOVED_KEY")).toBe(SECRET);
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(await getKey("MOVED_KEY")).toBe(SECRET);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    const lines = (
      console.info as unknown as { mock: { calls: string[][] } }
    ).mock.calls.map((c) => c[0]);
    expect(lines).toEqual(["[vault] MOVED_KEY read from vault (version v1)"]);
    expect(lines.join("")).not.toContain(SECRET);
  });
});

describe("stored-copy keys (today's behaviour)", () => {
  it.each(["WAITING_KEY", "KEPT_OUT"])(
    "%s: stored copy used; missing throws",
    async (name) => {
      await expect(getKey(name)).rejects.toThrow(/is not set/);
      process.env[name] = SECRET;
      expect(await getKey(name)).toBe(SECRET);
    },
  );

  it("says why a pending or exception key has no value", async () => {
    await expect(getKey("WAITING_KEY")).rejects.toThrow(
      /not yet moved to the vault/,
    );
    await expect(getKey("KEPT_OUT")).rejects.toThrow(/kept out of the vault/);
  });

  it("a pending key never touches the vault", async () => {
    process.env.WAITING_KEY = SECRET;
    setVaultForTests(
      {
        read: async () => {
          throw new Error("must not be called");
        },
      },
      LAYER,
    );
    expect(await getKey("WAITING_KEY")).toBe(SECRET);
  });

  it("previous reads NAME_PREVIOUS", async () => {
    process.env.WAITING_KEY_PREVIOUS = OLD;
    expect(await getKey("WAITING_KEY", { version: "previous" })).toBe(OLD);
  });

  it("logs the source once, never the value, even after the cache expires", async () => {
    process.env.KEPT_OUT = SECRET;
    vi.useFakeTimers();
    try {
      await getKey("KEPT_OUT");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(await getKey("KEPT_OUT")).toBe(SECRET);
    } finally {
      vi.useRealTimers();
    }
    const lines = (
      console.info as unknown as { mock: { calls: string[][] } }
    ).mock.calls.map((c) => c[0]);
    expect(lines).toEqual([
      "[vault] KEPT_OUT read from stored copy (exception)",
    ]);
  });
});

describe("refusals", () => {
  it("a name not in the register is refused, even when the variable is set", async () => {
    process.env.NOT_REGISTERED = SECRET;
    await expect(getKey("NOT_REGISTERED")).rejects.toThrow(
      /not in the key register/,
    );
    await expect(getKey("toString")).rejects.toThrow(/not in the key register/);
  });

  it("an unknown version is refused", async () => {
    await expect(
      getKey("KEPT_OUT", { version: "next" as unknown as "current" }),
    ).rejects.toThrow(/version must be 'current' or 'previous'/);
  });

  it("an unknown backend is refused", async () => {
    process.env.VAULT_BACKEND = "nope";
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /unknown VAULT_BACKEND 'nope'/,
    );
  });
});

describe("AWS backend", () => {
  function fakeAws(send: (cmd: { input: unknown }) => Promise<unknown>) {
    const made: { config?: unknown; roleArn?: string } = {};
    const modules: Record<string, unknown> = {
      "@aws-sdk/client-secrets-manager": {
        SecretsManagerClient: class {
          constructor(config: unknown) {
            made.config = config;
          }
          send = send;
        },
        GetSecretValueCommand: class {
          constructor(public input: unknown) {}
        },
      },
      "@vercel/functions/oidc": {
        awsCredentialsProvider: (opts: { roleArn: string }) => {
          made.roleArn = opts.roleArn;
          return "creds";
        },
      },
    };
    const load = vi.fn(async (s: string) => {
      if (!(s in modules)) throw new Error(`not installed: ${s}`);
      return modules[s];
    });
    return { load, made };
  }

  it("is the default backend and fails plainly without its packages", async () => {
    process.env.VAULT_BACKEND = "aws";
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /AWS packages are not installed/,
    );
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /AWS packages are not installed/,
    ); // same backend, reused
    delete process.env.VAULT_BACKEND;
    setVaultForTests(null, LAYER);
    await expect(getKey("MOVED_KEY")).rejects.toThrow(
      /AWS packages are not installed/,
    );
  });

  it("needs the app's vault role", async () => {
    const { load } = fakeAws(async () => ({}));
    await expect(
      new AwsVault(load).read("app/demo/MOVED_KEY", "current"),
    ).rejects.toThrow(/VAULT_ROLE_ARN is not set/);
    expect(load).not.toHaveBeenCalled();
  });

  it("reads the right stage with the app's role, and connects once", async () => {
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    const inputs: unknown[] = [];
    const { load, made } = fakeAws(async (cmd) => {
      inputs.push(cmd.input);
      return { SecretString: SECRET, VersionId: "abc" };
    });
    const v = new AwsVault(load);
    expect(await v.read("app/demo/MOVED_KEY", "current")).toEqual({
      value: SECRET,
      versionId: "abc",
    });
    expect(await v.read("app/demo/MOVED_KEY", "previous")).toEqual({
      value: SECRET,
      versionId: "abc",
    });
    expect(inputs).toEqual([
      { SecretId: "app/demo/MOVED_KEY", VersionStage: "AWSCURRENT" },
      { SecretId: "app/demo/MOVED_KEY", VersionStage: "AWSPREVIOUS" },
    ]);
    expect(made.roleArn).toBe(
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod",
    );
    expect(made.config).toEqual({ region: "eu-west-2", credentials: "creds" });
    expect(load).toHaveBeenCalledTimes(2); // two modules, loaded once
  });

  it("a missing version id reads as '?'", async () => {
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    const { load } = fakeAws(async () => ({ SecretString: SECRET }));
    expect(await new AwsVault(load).read("x", "current")).toEqual({
      value: SECRET,
      versionId: "?",
    });
  });

  it.each([
    ["AccessDeniedException", /may not read it/],
    ["ResourceNotFoundException", /no current value stored in the vault/],
    ["DecryptionFailure", /could not decrypt it/],
    ["ThrottlingException", /the vault refused \(ThrottlingException\)/],
    [undefined, /the vault refused \(unknown\)/],
  ])("AWS error %s → plain reason", async (name, reason) => {
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    const { load } = fakeAws(async () => {
      throw Object.assign(
        new Error(`detail ${SECRET}`),
        name ? { name } : { name: undefined },
      );
    });
    await expect(new AwsVault(load).read("x", "current")).rejects.toSatisfy(
      (e: unknown) =>
        notEchoing(SECRET)(e) && reason.test((e as Error).message),
    );
  });

  it("a thrown non-object is still a plain refusal", async () => {
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    const { load } = fakeAws(async () => {
      throw null;
    });
    await expect(new AwsVault(load).read("x", "current")).rejects.toThrow(
      /the vault refused \(unknown\)/,
    );
  });

  it("a binary value is refused", async () => {
    process.env[VAULT_ROLE_ENV] =
      "arn:aws:iam::000000000000:role/vault/vercel-demo-prod";
    const { load } = fakeAws(async () => ({
      SecretBinary: new Uint8Array([1]),
    }));
    await expect(new AwsVault(load).read("x", "current")).rejects.toThrow(
      /binary, not text/,
    );
  });
});

describe("helpers", () => {
  it("vaultUnavailable is a plain 503", async () => {
    const r = vaultUnavailable();
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/could not be read/);
  });

  it("isVaultError tells vault errors apart", () => {
    expect(isVaultError(new VaultError("x"))).toBe(true);
    expect(isVaultError(new Error("x"))).toBe(false);
  });
});

describe("the register copy (lib/vault-layer.json)", () => {
  const keys = layerFile.keys as Layer;

  it("names the template's keys, with no values", () => {
    for (const n of [
      "AUTH_SECRET",
      "MFA_ENCRYPTION_KEY",
      "DATABASE_URL",
      "STRIPE_SECRET_KEY",
    ]) {
      expect(keys[n]).toBeDefined();
    }
    for (const e of Object.values(keys)) {
      expect(Object.keys(e).sort()).toEqual(["status", "vault"]);
      expect(["migrated", "pending", "exception"]).toContain(e.status);
    }
  });

  it("a moved key names its vault entry as app/<slug>/<NAME>", () => {
    for (const [name, e] of Object.entries(keys)) {
      if (e.status === "exception") expect(e.vault).toBeNull();
      else expect(e.vault).toMatch(new RegExp(`^app/[a-z0-9-]+/${name}$`));
    }
  });

  it("nothing is switched over yet: every key keeps its stored copy", () => {
    expect(Object.values(keys).every((e) => e.status === "exception")).toBe(
      true,
    );
  });

  it("the real map is used when no override is given", async () => {
    setVaultForTests(null);
    process.env.NOT_REGISTERED = SECRET;
    await expect(getKey("NOT_REGISTERED")).rejects.toThrow(
      /not in the key register/,
    );
  });
});

describe("nothing else calls AWS", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const SKIP = new Set([
    "node_modules",
    ".next",
    ".git",
    "coverage",
    "playwright-report",
    "test-results",
  ]);
  const ALLOWED = new Set(["lib/vault.ts", "tests/unit/vault.test.ts"]);

  function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.(c|m)?(t|j)sx?$/.test(name)) yield p;
    }
  }

  it("only lib/vault.ts names @aws-sdk/* or the Vercel OIDC helper", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      if (
        /@aws-sdk\/|@vercel\/functions\/oidc/.test(readFileSync(file, "utf8"))
      )
        offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
