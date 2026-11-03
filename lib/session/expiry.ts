// When this browser's session ends (app-business-core issue 525), read from the
// session cookie itself so the expiry warning is exact: the cookie's `exp` is set
// from the session's own life (auth.config.ts encode, lib/session/lifetime.ts).
// Never throws: no readable session = no warning.

import "server-only";

import { cookies } from "next/headers";
import { decode } from "@auth/core/jwt";

const COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

export type SessionTiming = { expiresAt: number; maxAgeSeconds: number };

/** The session cookie's value (a chunked cookie is joined), and its name. */
function sessionCookie(jar: { getAll(): { name: string; value: string }[] }): { name: string; value: string } | null {
  const all = jar.getAll();
  for (const name of COOKIE_NAMES) {
    const whole = all.find((c) => c.name === name);
    if (whole) return { name, value: whole.value };
    const chunks = all
      .filter((c) => c.name.startsWith(`${name}.`))
      .sort((a, b) => Number(a.name.slice(name.length + 1)) - Number(b.name.slice(name.length + 1)));
    if (chunks.length) return { name, value: chunks.map((c) => c.value).join("") };
  }
  return null;
}

export async function sessionTiming(secret: string | undefined = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET): Promise<SessionTiming | null> {
  try {
    if (!secret) return null;
    const cookie = sessionCookie(await cookies());
    if (!cookie) return null;
    const payload = await decode({ token: cookie.value, secret, salt: cookie.name });
    const exp = typeof payload?.exp === "number" ? payload.exp : null;
    if (exp === null) return null;
    const maxAge =
      typeof payload?.maxAge === "number"
        ? payload.maxAge
        : typeof payload?.iat === "number"
          ? exp - payload.iat
          : 0;
    return { expiresAt: exp * 1000, maxAgeSeconds: maxAge };
  } catch {
    return null;
  }
}
