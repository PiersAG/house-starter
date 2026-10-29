// The one "get key" layer for an app (#822, vault build plan § Step 5).
// Twin of the factory's agents/vault.py and dashboard/lib/vault.mjs — same rules,
// same messages.
//
// App code names a key (its name in the key register) and this layer decides where
// the value comes from, using ./vault-layer.json (a copy of the register's
// `template` and `per-app` entries):
//   migrated  → the vault only (app/<slug>/<NAME>). A missing or refused read
//               throws VaultError and NEVER falls back to process.env — the route
//               answers a plain 503.
//   pending   → the old stored copy (process.env of the same name), logged once.
//   exception → process.env; kept out of the vault for the register's reason.
//               Every key is here today: the K9Coach rebuild moves them (wave 5).
//   unknown   → VaultError: add the key to the register first.
//
// Nothing switches over in this file's first PR: no caller imports it yet, and
// every key is `exception`, so behaviour is unchanged.
//
// Nothing else in the app imports @aws-sdk/* (tests/unit/vault.test.ts). The AWS
// packages are loaded lazily, only when a migrated key is read, and are added to
// package.json with the first app key move. Swapping vaults later is one new
// backend with a read(vaultName, version) method.
//
// Node.js runtime only. Never imported by auth.config.ts or the Edge middleware.

import layerFile from "./vault-layer.json";
import { envValue } from "./secrets";

export type KeyVersion = "current" | "previous";
type Status = "migrated" | "pending" | "exception";
export type LayerEntry = { vault: string | null; status: Status };
export type Layer = Record<string, LayerEntry>;
export type VaultRead = { value: string; versionId: string };

export interface VaultBackend {
  read(vaultName: string, version: KeyVersion): Promise<VaultRead>;
}

const REGION = "eu-west-2";
/** Not a secret: the app's role in factory-vault (vercel-<slug>-prod), set at the K9Coach rebuild. */
export const VAULT_ROLE_ENV = "VAULT_ROLE_ARN";
const CACHE_MS = 5 * 60 * 1000;
const STAGES: Record<KeyVersion, string> = {
  current: "AWSCURRENT",
  previous: "AWSPREVIOUS",
};
const PREVIOUS_SUFFIX = "_PREVIOUS";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** Test double: { vaultName: value } or { vaultName: { current, previous } }. No network. */
export class FakeVault implements VaultBackend {
  constructor(
    private values: Record<
      string,
      string | Partial<Record<KeyVersion, string>>
    >,
  ) {}
  async read(vaultName: string, version: KeyVersion): Promise<VaultRead> {
    const stored = this.values[vaultName];
    let v: string | undefined;
    if (stored && typeof stored === "object") v = stored[version];
    else if (version === "current") v = stored;
    if (v == null)
      throw new VaultError(`no ${version} value is stored under ${vaultName}`);
    return { value: String(v), versionId: `fake-${version}` };
  }
}

// The two AWS modules, typed to the few members used, so the template type-checks
// before the packages are installed.
type SecretsManagerModule = {
  SecretsManagerClient: new (config: {
    region: string;
    credentials: unknown;
  }) => {
    send(
      command: unknown,
    ): Promise<{ SecretString?: string; VersionId?: string }>;
  };
  GetSecretValueCommand: new (input: {
    SecretId: string;
    VersionStage: string;
  }) => unknown;
};
type OidcModule = {
  awsCredentialsProvider(opts: { roleArn: string }): unknown;
};
export type ModuleLoader = (specifier: string) => Promise<unknown>;

const loadModule: ModuleLoader = (specifier) =>
  import(/* webpackIgnore: true */ specifier);

/** AWS Secrets Manager in factory-vault, through the app's Vercel OIDC pass. */
export class AwsVault implements VaultBackend {
  private client?: InstanceType<SecretsManagerModule["SecretsManagerClient"]>;
  private sm?: SecretsManagerModule;

  constructor(private load: ModuleLoader = loadModule) {}

  private async connect() {
    if (!this.client || !this.sm) {
      const roleArn = process.env[VAULT_ROLE_ENV];
      if (!roleArn)
        throw new VaultError(
          `${VAULT_ROLE_ENV} is not set, so this app has no vault role`,
        );
      let sm: SecretsManagerModule, oidc: OidcModule;
      try {
        sm = (await this.load(
          "@aws-sdk/client-secrets-manager",
        )) as SecretsManagerModule;
        oidc = (await this.load("@vercel/functions/oidc")) as OidcModule;
      } catch {
        throw new VaultError("the AWS packages are not installed in this app");
      }
      this.sm = sm;
      this.client = new sm.SecretsManagerClient({
        region: REGION,
        credentials: oidc.awsCredentialsProvider({ roleArn }),
      });
    }
    return { client: this.client, sm: this.sm };
  }

  async read(vaultName: string, version: KeyVersion): Promise<VaultRead> {
    const { client, sm } = await this.connect();
    let r: { SecretString?: string; VersionId?: string };
    try {
      r = await client.send(
        new sm.GetSecretValueCommand({
          SecretId: vaultName,
          VersionStage: STAGES[version],
        }),
      );
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      const reasons: Record<string, string> = {
        AccessDeniedException: "this deployment's role may not read it",
        ResourceNotFoundException: `there is no ${version} value stored in the vault`,
        DecryptionFailure: "the vault could not decrypt it",
      };
      throw new VaultError(
        (name && reasons[name]) || `the vault refused (${name ?? "unknown"})`,
      );
    }
    if (typeof r.SecretString !== "string")
      throw new VaultError("the stored value is binary, not text");
    return { value: r.SecretString, versionId: r.VersionId ?? "?" };
  }
}

const BACKENDS: Record<string, () => VaultBackend> = {
  aws: () => new AwsVault(),
};

let layer: Layer = layerFile.keys as Layer;
let testBackend: VaultBackend | null = null;
let backend: VaultBackend | null = null;
const cache = new Map<string, { at: number; value: string }>();
const logged = new Set<string>();

/** Install a FakeVault (or null) and clear every cache. `layerOverride` replaces the register map. */
export function setVaultForTests(
  fake: VaultBackend | null,
  layerOverride?: Layer,
): void {
  testBackend = fake;
  backend = null;
  layer = layerOverride ?? (layerFile.keys as Layer);
  cache.clear();
  logged.clear();
}

function job(): string {
  return process.env.VERCEL_ENV
    ? `the app (${process.env.VERCEL_ENV})`
    : "the app";
}

function vault(): VaultBackend {
  const name = process.env.VAULT_BACKEND ?? "aws";
  if (name === "fake") {
    if (!testBackend)
      throw new VaultError("VAULT_BACKEND=fake but no test vault is installed");
    return testBackend;
  }
  if (!backend) {
    if (!Object.hasOwn(BACKENDS, name)) {
      throw new VaultError(
        `unknown VAULT_BACKEND '${name}' (known: fake, aws)`,
      );
    }
    backend = BACKENDS[name]();
  }
  return backend;
}

/** The value of register key `name`. Throws VaultError (never the value), never returns empty. */
export async function getKey(
  name: string,
  opts: { version?: KeyVersion } = {},
): Promise<string> {
  const version = opts.version ?? "current";
  if (!Object.hasOwn(STAGES, version)) {
    throw new VaultError(`${name}: version must be 'current' or 'previous'`);
  }
  const id = `${name}\u0000${version}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const entry = Object.hasOwn(layer, name) ? layer[name] : undefined;
  if (!entry) {
    throw new VaultError(
      `${name} could not be read by ${job()}: it is not in the key register ` +
        "(app-business-core state/security/key-register.json) — add it there first",
    );
  }

  let value: string;
  if (entry.status === "migrated") {
    let r: VaultRead;
    try {
      if (!entry.vault)
        throw new VaultError("the register gives it no vault name");
      r = await vault().read(entry.vault, version);
    } catch (e) {
      const why =
        e instanceof VaultError ? e.message : "the vault could not be reached";
      throw new VaultError(
        `${name} could not be read from the vault by ${job()}: ${why}`,
      );
    }
    if (!r.value)
      throw new VaultError(
        `${name} could not be read from the vault by ${job()}: it is empty`,
      );
    value = r.value;
    if (!logged.has(id)) {
      console.info(`[vault] ${name} read from vault (version ${r.versionId})`);
      logged.add(id);
    }
  } else {
    const v = version === "current" ? name : name + PREVIOUS_SUFFIX;
    // the stored copy; a key the server took out of process.env (#760) comes
    // from lib/secrets.ts
    value = envValue(v) ?? "";
    if (!value) {
      const where =
        entry.status === "pending"
          ? "not yet moved to the vault"
          : "kept out of the vault";
      throw new VaultError(
        `${name} could not be read by ${job()}: it is ${where}, and the stored copy ${v} is not set`,
      );
    }
    if (!logged.has(id)) {
      console.info(`[vault] ${name} read from stored copy (${entry.status})`);
      logged.add(id);
    }
  }
  cache.set(id, { at: Date.now(), value });
  return value;
}

/** For a route: `catch (e) { if (isVaultError(e)) return vaultUnavailable(); throw e; }` */
export function isVaultError(e: unknown): e is VaultError {
  return e instanceof VaultError;
}

export function vaultUnavailable(): Response {
  return new Response(
    "Service unavailable: a key this page needs could not be read.",
    {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}
