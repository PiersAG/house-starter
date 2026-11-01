// Fetching an address a user supplied, without server-side request forgery
// (app-business-core issue 448, SEC.31; Matt Murphy #69: "allow-list external
// domains and block internal/metadata addresses; resolve the host once, pin
// that address and re-validate on every redirect; return one generic error
// ... and log the details where only your team can see them").
//
// The template fetches no user-supplied address today. A feature that does —
// a link preview, an import from a URL, a webhook to a customer's address —
// uses fetchUserUrl() and nothing else; the factory's security gate fails a
// fetch whose address comes from the request (factory.request-input-to-fetch).
//
// What it does, per hop (at most MAX_REDIRECTS redirects):
//   1. https only, the default port, no user name or password in the address;
//   2. the host must be on the caller's allow-list (exact, or a sub-domain of
//      an entry);
//   3. the host is resolved ONCE and every address checked: loopback, private,
//      link-local (including the cloud metadata address 169.254.169.254),
//      carrier-grade NAT, unique-local, multicast and unspecified addresses are
//      refused — never trusted because they are "internal" (Matt Murphy #13);
//   4. the connection is made to that resolved address (pinned), so a second
//      lookup cannot swap in an internal one (DNS rebinding);
//   5. a redirect is not followed blindly: its target goes through 1–4 again.
// Every refusal or failure throws the same OutboundFetchError with one generic
// message; the detail goes to the server log only.
//
// The process-wide egress allow-list (lib/egress.ts) still applies underneath.

import { lookup } from "node:dns/promises";
import { request } from "node:https";
import net from "node:net";

export const MAX_REDIRECTS = 3;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const TIMEOUT_MS = 10_000;

/** The one error every failed fetch of a user-supplied address throws. */
export class OutboundFetchError extends Error {
  constructor() {
    super("We could not fetch that address.");
    this.name = "OutboundFetchError";
  }
}

/** True for an address that must never be fetched on a user's behalf. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || // unspecified / "this network"
      a === 10 || // private
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 192 && b === 0) || // IETF protocol assignments
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }
  if (family === 6) {
    const v = address.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v); // unique-local, link-local, multicast
  }
  return true; // not an address at all
}

function allowedHost(host: string, allowHosts: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowHosts.some((entry) => {
    const e = entry.toLowerCase();
    return h === e || h.endsWith(`.${e}`);
  });
}

/** Why this address may not be fetched, or null. Exported for the tests. */
export function addressProblem(raw: string, allowHosts: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not an absolute URL";
  }
  if (url.protocol !== "https:") return `scheme ${url.protocol} refused`;
  if (url.username || url.password) return "credentials in the address";
  if (url.port && url.port !== "443") return `port ${url.port} refused`;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return "a literal IP address";
  if (!allowedHost(host, allowHosts)) return `host ${host} is not on the allow-list`;
  return null;
}

type Logger = (detail: Record<string, string | number>) => void;
const serverLog: Logger = (detail) =>
  console.warn(JSON.stringify({ event: "outbound_fetch_refused", ...detail }));

export interface FetchUserUrlOptions {
  /** The external domains this feature may reach. Required: there is no default. */
  allowHosts: readonly string[];
  /** Replaceable for tests. */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Replaceable for tests: performs one pinned GET and returns status, headers, body. */
  get?: (url: URL, address: string, family: number) => Promise<{ status: number; location?: string; body: string }>;
  log?: Logger;
}

function pinnedGet(url: URL, address: string, family: number) {
  return new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        timeout: TIMEOUT_MS,
        // Connect to the address that was checked, never a fresh lookup.
        lookup: (_h, _o, cb) => cb(null, address, family),
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: typeof res.headers.location === "string" ? res.headers.location : undefined,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET a user-supplied https address under the rules above. Returns the body of
 * the final 2xx answer; throws OutboundFetchError for everything else.
 */
export async function fetchUserUrl(raw: string, options: FetchUserUrlOptions): Promise<string> {
  const log = options.log ?? serverLog;
  const resolve = options.resolve ?? ((h: string) => lookup(h, { all: true, verbatim: true }));
  const get = options.get ?? pinnedGet;
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = addressProblem(current, options.allowHosts);
    if (problem) {
      log({ reason: problem, hop, address: current.slice(0, 200) });
      throw new OutboundFetchError();
    }
    const url = new URL(current);
    let addresses: { address: string; family: number }[];
    try {
      addresses = await resolve(url.hostname);
    } catch (error) {
      log({ reason: "lookup failed", hop, host: url.hostname, error: String(error).slice(0, 200) });
      throw new OutboundFetchError();
    }
    const blocked = addresses.find((a) => isBlockedAddress(a.address));
    if (addresses.length === 0 || blocked) {
      log({ reason: "resolves to an internal address", hop, host: url.hostname, address: blocked?.address ?? "none" });
      throw new OutboundFetchError();
    }
    let res;
    try {
      res = await get(url, addresses[0].address, addresses[0].family);
    } catch (error) {
      log({ reason: "request failed", hop, host: url.hostname, error: String(error).slice(0, 200) });
      throw new OutboundFetchError();
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, url).toString(); // checked again at the top
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    log({ reason: `answered ${res.status}`, hop, host: url.hostname });
    throw new OutboundFetchError();
  }
  log({ reason: "too many redirects", address: raw.slice(0, 200) });
  throw new OutboundFetchError();
}
