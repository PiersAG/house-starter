// Each module receives only the keys it needs (PiersAG/app-business-core#760,
// Matt Murphy #67: "each module receives only the environment variables that it
// needs, not the full process.env object").
//
// WHY THIS EXISTS
// ---------------
// On a Node server every package in the dependency tree can read process.env, so
// one compromised or typosquatted package could read every key the app holds.
// At server start (instrumentation.ts → scrubSecretsFromEnv) every key that
// ./key-access.json marks `scrub: true` is moved out of process.env into a
// private store held here. From then on:
//
//   * a package that reads process.env.STRIPE_SECRET_KEY gets `undefined`;
//   * our own code reads a key with readSecret(NAME), and only the files the
//     manifest lists as that key's readers do so — tests/unit/key-access.test.ts
//     fails the build when any other file names the key.
//
// This is the one delivery path for a key inside the app (#484): the deploy (or,
// once a key moves, the vault — lib/vault.ts) supplies the value, and code reads
// it here by name. Adding a key is one entry in key-access.json plus its line in
// .env.contract.
//
// Before the scrub (scripts, tests, the CLI) readSecret reads process.env, so
// nothing outside the running server changes. A caller that passes its own env
// object (tests do) reads from that object.
//
// Node.js runtime only. Never imported by auth.config.ts or the Edge middleware.

import manifest from "./key-access.json";

type KeyEntry = { readers: string[]; scrub: boolean };
const KEYS = manifest.keys as Record<string, KeyEntry>;

/** Keys the server takes out of process.env at start. */
export const SCRUBBED_KEYS: readonly string[] = Object.keys(KEYS).filter(
  (k) => KEYS[k].scrub,
);

/** Raised for a key the manifest does not list. Names the key, never a value. */
export class SecretAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretAccessError";
  }
}

// Held on globalThis so a dev-server module reload does not lose the values that
// were already taken out of process.env.
const g = globalThis as unknown as {
  __appSecretStore?: Map<string, string>;
  __appSecretsScrubbed?: boolean;
};
const store: Map<string, string> = g.__appSecretStore ?? (g.__appSecretStore = new Map());

/**
 * Move every scrubbed key out of process.env into the private store. Called once
 * by instrumentation.ts after the boot check. Safe to call again (a later call
 * moves any key that has reappeared, e.g. after a dev-server env reload).
 * Returns the names moved — never a value.
 */
export function scrubSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const moved: string[] = [];
  for (const name of SCRUBBED_KEYS) {
    const v = env[name];
    if (v !== undefined) {
      if (v !== "") store.set(name, v);
      delete env[name];
      moved.push(name);
    }
  }
  if (env === process.env) g.__appSecretsScrubbed = true;
  return moved;
}

/** True once the server has taken its keys out of process.env. */
export function secretsScrubbed(): boolean {
  return g.__appSecretsScrubbed === true;
}

/**
 * The value of key `name`, or undefined when it is not set. Only the files
 * key-access.json lists for `name` may call this (enforced by the key-access
 * test). `env` is for tests and scripts that pass their own environment.
 */
export function readSecret(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!Object.hasOwn(KEYS, name)) {
    throw new SecretAccessError(
      `${name} is not in lib/key-access.json — add it there, with the files that read it, first`,
    );
  }
  if (env !== process.env) return env[name];
  // process.env first: a key put back after the scrub (a dev-server env reload)
  // is the newer value.
  return process.env[name] ?? store.get(name);
}

/**
 * For lib/vault.ts only: the environment value of a register key, whether or not
 * key-access.json lists it. A listed key comes from the store (it has left
 * process.env); any other name is read from process.env as before.
 */
export function envValue(name: string): string | undefined {
  return Object.hasOwn(KEYS, name) ? readSecret(name) : process.env[name];
}

/** Test hook: forget every stored value and the scrubbed flag. */
export function __resetSecretsForTests(): void {
  store.clear();
  g.__appSecretsScrubbed = false;
}
