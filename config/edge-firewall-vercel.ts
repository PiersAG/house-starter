// The edge firewall rule set, translated for Vercel's firewall (app-business-core
// #511, #754; CEO ruling 2026-11-02 on #702: Vercel's own firewall).
//
// ONE SOURCE OF TRUTH. The rules live in config/edge-firewall.ts. This file only
// translates them, and `npm run edge:firewall:config` writes the translation to
// config/edge-firewall.vercel.json, which the factory applies to each app's
// Vercel project with OpenTofu (app-business-core infra/edge-firewall/) and reads
// back every day (agents/vercel_settings.py). The JSON is never edited by hand:
// tests/unit/edge-firewall-vercel.test.ts fails when it and this translation
// disagree.
//
// NOTHING IS DROPPED OR MERGED AWAY. Every rule in EDGE_RULES becomes one Vercel
// custom rule, every pattern one condition group (any group matching is a hit,
// as in matchEdgeRule), the sign-in limit's two thresholds two rate-limit rules,
// and the bot check one challenge rule on its paths. If that does not fit the
// project's Vercel plan, `fits` says so and the factory refuses to apply it — it
// never applies part of the set (`planLimits` below).
//
// The shape is the OpenTofu provider's `vercel_firewall_config` schema
// (vercel/vercel 3.17.1, read from `tofu providers schema` 2026-11-26), in
// snake_case, so the factory's module passes it through unchanged.

import {
  EDGE_AUTH_RATE_LIMITS,
  EDGE_BOT_PROTECTED_PATHS,
  EDGE_FIREWALL_PROVIDER,
  EDGE_RULES,
  type EdgeRule,
} from "./edge-firewall";

/**
 * Which part of the request each rule is matched against, in Vercel's condition
 * types (the provider's own list, 3.17.1: host, path, method, header, query,
 * cookie, target_path, ip_address, …, user_agent). The query rules use `query`
 * with no key, so the pattern is matched against the query string as a whole,
 * as matchEdgeRule does. That reading of a key-less `query` condition, and
 * whether Vercel matches the decoded or the raw text, are INFERRED, not
 * confirmed: the first apply to a project on a plan that holds the set runs
 * scripts/edge-check.mjs, whose encoded payloads (e.g. `%27%20OR`) settle both.
 * If Vercel refuses a key-less `query` condition, it refuses the whole
 * configuration, so nothing is applied in part.
 */
export const VERCEL_CONDITION_TYPE: Record<EdgeRule["on"], string> = {
  path: "path",
  query: "query",
  "user-agent": "user_agent",
};

/**
 * Vercel's per-project limits (vercel.com/docs/vercel-firewall/vercel-waf,
 * Limits; Vercel Academy "Firewall Rules"; as given in Dispatch CD, 2026-11-26,
 * not re-read by the dispatch). Rate-limit rules are custom rules too, so they
 * count in both numbers. Pro's rate-limit figure is its custom-rule limit.
 */
export const VERCEL_PLAN_LIMITS = {
  hobby: { customRules: 3, rateLimitRules: 1 },
  pro: { customRules: 40, rateLimitRules: 40 },
} as const;

export type VercelPlan = keyof typeof VERCEL_PLAN_LIMITS;

type Condition = {
  type: string;
  op: string;
  value?: string;
  values?: string[];
};
type ConditionGroup = { conditions: Condition[] };
type RateLimit = {
  algo: "fixed_window";
  window: number;
  limit: number;
  keys: string[];
  action: "challenge" | "deny";
};
/** Vercel refuses a rule name shorter than 4 characters (provider 3.17.1), so every
 * name carries the `edge-` prefix, which also marks the rules this set owns. */
export type VercelRule = {
  name: string;
  description: string;
  active: true;
  condition_group: ConditionGroup[];
  action: {
    action: "deny" | "challenge" | "rate_limit";
    rate_limit?: RateLimit;
  };
};

/** A JavaScript pattern as an RE2 pattern: same source, `i` flag as `(?i)`. */
export function re2(p: RegExp): string {
  const unsupported = p.flags.replace(/i/g, "");
  if (unsupported)
    throw new Error(
      `edge pattern ${p} uses flag(s) "${unsupported}" Vercel cannot express`,
    );
  return (p.flags.includes("i") ? "(?i)" : "") + p.source;
}

/** Path conditions: an entry ending in "/" covers everything under it, any other is exact. */
function pathGroups(paths: readonly string[]): ConditionGroup[] {
  const exact = paths.filter((p) => !p.endsWith("/"));
  const prefixes = paths.filter((p) => p.endsWith("/"));
  const groups: ConditionGroup[] = [];
  if (exact.length)
    groups.push({
      conditions: [{ type: "path", op: "inc", values: [...exact] }],
    });
  for (const p of prefixes)
    groups.push({ conditions: [{ type: "path", op: "pre", value: p }] });
  return groups;
}

export function vercelRules(): VercelRule[] {
  const rules: VercelRule[] = EDGE_RULES.map((r) => ({
    name: `edge-${r.id}`,
    description: r.purpose,
    active: true,
    condition_group: r.patterns.map((p) => ({
      conditions: [
        { type: VERCEL_CONDITION_TYPE[r.on], op: "re", value: re2(p) },
      ],
    })),
    action: { action: r.action },
  }));
  const signIn = pathGroups(EDGE_AUTH_RATE_LIMITS.paths);
  const limit = (
    name: string,
    above: number,
    action: RateLimit["action"],
  ): VercelRule => ({
    name,
    description: `Sign-in routes: more than ${above} requests a minute from one address → ${action}`,
    active: true,
    condition_group: signIn,
    action: {
      action: "rate_limit",
      rate_limit: {
        algo: "fixed_window",
        window: EDGE_AUTH_RATE_LIMITS.windowSeconds,
        limit: above,
        keys: ["ip"],
        action,
      },
    },
  });
  rules.push(
    limit(
      "edge-sign-in-rate-challenge",
      EDGE_AUTH_RATE_LIMITS.challengeAbove,
      "challenge",
    ),
  );
  rules.push(
    limit("edge-sign-in-rate-deny", EDGE_AUTH_RATE_LIMITS.denyAbove, "deny"),
  );
  rules.push({
    name: "edge-bot-check",
    description:
      "High-value routes: automated traffic is challenged (Vercel's challenge lets browsers through)",
    active: true,
    condition_group: pathGroups(EDGE_BOT_PROTECTED_PATHS),
    action: { action: "challenge" },
  });
  return rules;
}

/** What the set needs, and which plans hold it whole. */
export function planLimits(rules: VercelRule[] = vercelRules()) {
  const needs = {
    custom_rules: rules.length,
    rate_limit_rules: rules.filter((r) => r.action.action === "rate_limit")
      .length,
  };
  const fits = Object.fromEntries(
    (Object.keys(VERCEL_PLAN_LIMITS) as VercelPlan[]).map((plan) => [
      plan,
      needs.custom_rules <= VERCEL_PLAN_LIMITS[plan].customRules &&
        needs.rate_limit_rules <= VERCEL_PLAN_LIMITS[plan].rateLimitRules,
    ]),
  ) as Record<VercelPlan, boolean>;
  return { needs, fits };
}

/**
 * Vercel's managed rule sets, declared so an apply (which replaces the whole
 * firewall configuration) states them rather than dropping them. Both stay off:
 * the bot check above is limited to its paths, and Vercel's managed bot
 * protection covers the whole project. The OWASP set is Enterprise only, so it is
 * not declared. A project where someone switched one on shows the change in the
 * plan before any apply, and in the daily read-back as drift.
 */
export const VERCEL_MANAGED_RULESETS = {
  bot_protection: { active: false, action: "challenge" },
  ai_bots: { active: false, action: "deny" },
} as const;

/** The whole document written to config/edge-firewall.vercel.json. */
export function vercelFirewallConfig() {
  const rules = vercelRules();
  const { needs, fits } = planLimits(rules);
  return {
    _comment:
      "GENERATED from config/edge-firewall.ts by `npm run edge:firewall:config` (config/edge-firewall-vercel.ts) — do not edit. Applied to each app's Vercel project by app-business-core infra/edge-firewall/ and read back daily by agents/vercel_settings.py. `fits` false for a plan means the factory refuses to apply the set to a project on that plan.",
    provider: EDGE_FIREWALL_PROVIDER,
    plan_limits: VERCEL_PLAN_LIMITS,
    needs,
    fits,
    enabled: true,
    managed_rulesets: VERCEL_MANAGED_RULESETS,
    rules,
  };
}

/** The file's exact text: what the script writes and the test compares. */
export function renderVercelFirewallConfig(): string {
  return JSON.stringify(vercelFirewallConfig(), null, 2) + "\n";
}
