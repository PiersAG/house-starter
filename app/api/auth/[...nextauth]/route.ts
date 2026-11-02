import { handlers } from "@/lib/auth";

import { withRouteLimit } from "@/lib/abuse/route-limit";
const { GET: nextAuthGet, POST: nextAuthPost } = handlers;

// The route limit and escalation (app-business-core issues 787 and 748): the session
// reads (GET) get the default budget, sign-in posts (POST) the sign-in one; the
// per-attempt sign-in limit still runs inside authorize.
export const GET = withRouteLimit("app.default", nextAuthGet);
export const POST = withRouteLimit("auth.signin", nextAuthPost);
