// Where this app's errors go, from SENTRY_DSN and the switch in
// config/error-tracking.ts (PiersAG/app-business-core#761; decision #700: the
// EU data region only).
//
// One reading of the address for the egress guard, the health check, the root
// layout and the report route. Server-only: it reads SENTRY_DSN. A DSN is accepted only when
// it is Sentry's EU ingest address and carries no secret part:
//
//   https://<32 hex public key>@o<digits>.ingest.de.sentry.io/<digits>
//
// Anything else — a US address (ingest.sentry.io / ingest.us.sentry.io), a
// self-hosted one, an old DSN with a secret key after the public key, a path,
// a query — counts as "no key set": nothing is sent.

import "server-only";

import { errorTrackingConfig, type ErrorTrackingConfig } from "@/config/error-tracking";

/** Sentry's EU ingest hosts are o<org id> under this domain. */
export const SENTRY_EU_INGEST_DOMAIN = "ingest.de.sentry.io";

const EU_HOST = /^o\d{1,20}\.ingest\.de\.sentry\.io$/;
const PUBLIC_KEY = /^[0-9a-f]{32}$/;
const PROJECT_PATH = /^\/(\d{1,20})$/;

export interface SentryTarget {
  /** e.g. https://o123.ingest.de.sentry.io */
  origin: string;
  host: string;
  publicKey: string;
  projectId: string;
  /** Where events are posted: <origin>/api/<project>/envelope/ */
  envelopeUrl: string;
}

/** The EU target a DSN names, or null when it is not an acceptable EU DSN. */
export function parseSentryDsn(raw: string | undefined | null): SentryTarget | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "") return null;
  if (url.password !== "" || url.search !== "" || url.hash !== "") return null;
  const host = url.hostname.toLowerCase();
  if (!EU_HOST.test(host)) return null;
  const publicKey = decodeURIComponent(url.username).toLowerCase();
  if (!PUBLIC_KEY.test(publicKey)) return null;
  const project = PROJECT_PATH.exec(url.pathname);
  if (!project) return null;
  const origin = `https://${host}`;
  return {
    origin,
    host,
    publicKey,
    projectId: project[1],
    envelopeUrl: `${origin}/api/${project[1]}/envelope/`,
  };
}

/**
 * The target to send to, or null when nothing may be sent: the switch is off,
 * SENTRY_DSN is unset, or it is not an EU DSN.
 */
export function errorTrackingTarget(
  env: NodeJS.ProcessEnv = process.env,
  config: Pick<ErrorTrackingConfig, "enabled"> = errorTrackingConfig,
): SentryTarget | null {
  if (!config.enabled) return null;
  return parseSentryDsn(env.SENTRY_DSN);
}

/** Plain words for the health check: is error tracking switched on and connected? */
export function errorTrackingStatus(
  env: NodeJS.ProcessEnv = process.env,
  config: Pick<ErrorTrackingConfig, "enabled"> = errorTrackingConfig,
): { on: false } | { on: true; ok: boolean; detail: string } {
  if (!config.enabled) return { on: false };
  if (!(env.SENTRY_DSN ?? "").trim()) {
    return { on: true, ok: false, detail: "error tracking is on but SENTRY_DSN is not set: nothing is sent" };
  }
  if (!errorTrackingTarget(env, config)) {
    return {
      on: true,
      ok: false,
      detail: "SENTRY_DSN is not a Sentry EU (ingest.de.sentry.io) address: nothing is sent",
    };
  }
  return { on: true, ok: true, detail: "errors are sent to Sentry (EU)" };
}
