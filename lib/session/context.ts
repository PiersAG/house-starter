// The request's context for sign-in risk and context-aware access
// (app-business-core issues 519 and 741; Matt Murphy #89: "evaluate location,
// device, time").
//
// LOCATION comes from the hosting platform's own reading of the connection:
// Vercel sets x-vercel-ip-country, -latitude, -longitude and -timezone on every
// request at its edge and overwrites anything a caller sent, so on Vercel these
// cannot be forged. The address itself is never stored (config/personal-data.ts).
// Off Vercel (local runs, tests) the headers are whatever the request carried, so
// a test can set them.
//
// DEVICE is a random id the browser keeps in a long-lived cookie (DEVICE_COOKIE),
// set by the sign-in action. A browser that has never signed in has none, which
// is exactly "an unrecognised device".

import "server-only";

import { cookies, headers } from "next/headers";
import type { HeadersLike } from "@/lib/rate-limit";

export const DEVICE_COOKIE = "hs_device";
const DEVICE_COOKIE_DAYS = 400; // the most a browser keeps a cookie

export type RequestContext = {
  deviceId: string | null;
  deviceLabel: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
};

export const EMPTY_CONTEXT: RequestContext = {
  deviceId: null,
  deviceLabel: null,
  country: null,
  latitude: null,
  longitude: null,
  timezone: null,
};

function coordinate(value: string | null, limit: number): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** "Chrome on Windows" — the kind of browser and device, for the device list. */
export function deviceLabelFromUserAgent(ua: string | null): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown browser";
}

/** The context of a request, from its headers and its device cookie value. */
export function contextFromHeaders(h: HeadersLike, deviceCookie: string | null = null): RequestContext {
  const country = (h.get("x-vercel-ip-country") ?? "").trim().toUpperCase();
  const deviceId = deviceCookie && /^[A-Za-z0-9_-]{16,64}$/.test(deviceCookie) ? deviceCookie : null;
  return {
    deviceId,
    deviceLabel: deviceLabelFromUserAgent(h.get("user-agent")),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    latitude: coordinate(h.get("x-vercel-ip-latitude"), 90),
    longitude: coordinate(h.get("x-vercel-ip-longitude"), 180),
    timezone: (h.get("x-vercel-ip-timezone") ?? "").trim() || null,
  };
}

/** The current request's context. Never throws: outside a request it is empty. */
export async function currentRequestContext(): Promise<RequestContext> {
  try {
    const [h, jar] = await Promise.all([headers(), cookies()]);
    return contextFromHeaders(h, jar.get(DEVICE_COOKIE)?.value ?? null);
  } catch {
    return EMPTY_CONTEXT;
  }
}

/**
 * Give this browser a device id if it has none (the sign-in action calls it
 * before signing in). Returns the id. Never throws.
 */
export async function ensureDeviceCookie(): Promise<string | null> {
  try {
    const jar = await cookies();
    const existing = jar.get(DEVICE_COOKIE)?.value;
    if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
    const id = crypto.randomUUID().replace(/-/g, "");
    jar.set(DEVICE_COOKIE, id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: DEVICE_COOKIE_DAYS * 24 * 60 * 60,
    });
    return id;
  } catch {
    return null;
  }
}
