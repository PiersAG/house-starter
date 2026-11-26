// The Vercel translation of the edge firewall rule set (app-business-core #511,
// #754): the committed config/edge-firewall.vercel.json is exactly what
// config/edge-firewall.ts produces, nothing is dropped or loosened on the way,
// and the plan check says plainly whether the set fits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EDGE_AUTH_RATE_LIMITS,
  EDGE_BOT_PROTECTED_PATHS,
  EDGE_RULES,
  matchEdgeRule,
} from "@/config/edge-firewall";
import {
  VERCEL_PLAN_LIMITS,
  planLimits,
  re2,
  renderVercelFirewallConfig,
  vercelFirewallConfig,
  vercelRules,
} from "@/config/edge-firewall-vercel";

const FILE = join(__dirname, "..", "..", "config", "edge-firewall.vercel.json");
const payloads = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "config", "edge-check-payloads.json"),
    "utf8",
  ),
);

describe("one source of truth", () => {
  it("the committed JSON is exactly what config/edge-firewall.ts generates (run `npm run edge:firewall:config`)", () => {
    expect(readFileSync(FILE, "utf8")).toBe(renderVercelFirewallConfig());
  });

  it("a rule changed in the TS file and not regenerated is caught", () => {
    const committed = JSON.parse(readFileSync(FILE, "utf8"));
    const changed = structuredClone(committed);
    changed.rules[0].condition_group.pop();
    expect(changed).not.toEqual(vercelFirewallConfig());
  });
});

describe("nothing dropped, merged away or loosened", () => {
  const rules = vercelRules();

  it("every edge rule is its own Vercel rule, every pattern its own condition group, same action", () => {
    for (const r of EDGE_RULES) {
      const v = rules.find((x) => x.name === `edge-${r.id}`);
      expect(v, r.id).toBeDefined();
      expect(v!.action.action).toBe(r.action);
      expect(v!.condition_group.map((g) => g.conditions[0].value)).toEqual(
        r.patterns.map(re2),
      );
    }
  });

  it("each translated pattern means what the original means (round trip, case-insensitive kept)", () => {
    for (const r of EDGE_RULES)
      for (const p of r.patterns) {
        const s = re2(p);
        const back = s.startsWith("(?i)")
          ? new RegExp(s.slice(4), "i")
          : new RegExp(s);
        expect(back.source).toBe(p.source);
        expect(back.flags).toBe(p.flags);
      }
  });

  it("every attack payload still trips the rule it was written for", () => {
    for (const a of payloads.attacks)
      expect(matchEdgeRule(a)?.id, JSON.stringify(a)).toBe(a.rule);
  });

  it("the sign-in limit keeps BOTH thresholds: challenge above 20 and block above 60 a minute, per address", () => {
    const rl = rules.filter((r) => r.action.action === "rate_limit");
    expect(
      rl.map((r) => [r.action.rate_limit!.limit, r.action.rate_limit!.action]),
    ).toEqual([
      [EDGE_AUTH_RATE_LIMITS.challengeAbove, "challenge"],
      [EDGE_AUTH_RATE_LIMITS.denyAbove, "deny"],
    ]);
    for (const r of rl) {
      expect(r.action.rate_limit!.window).toBe(
        EDGE_AUTH_RATE_LIMITS.windowSeconds,
      );
      expect(r.action.rate_limit!.keys).toEqual(["ip"]);
      const covered = r.condition_group.flatMap((g) =>
        g.conditions.flatMap((c) => c.values ?? [c.value]),
      );
      expect(covered.sort()).toEqual([...EDGE_AUTH_RATE_LIMITS.paths].sort());
    }
  });

  it("the bot check challenges sign-in, sign-up, pricing and checkout", () => {
    const bot = rules.find((r) => r.name === "edge-bot-check")!;
    expect(bot.action.action).toBe("challenge");
    const covered = bot.condition_group.flatMap((g) =>
      g.conditions.flatMap((c) => c.values ?? [c.value]),
    );
    expect(covered.sort()).toEqual([...EDGE_BOT_PROTECTED_PATHS].sort());
  });

  it("a pattern flag Vercel cannot express is refused, not dropped", () => {
    expect(() => re2(/x/g)).toThrow(/cannot express/);
  });
});

describe("does the set fit the plan (Dispatch CD item 2)", () => {
  it("needs 8 custom rules, 2 of them rate limits: not Hobby (3 and 1), Pro holds it whole", () => {
    const { needs, fits } = planLimits();
    expect(needs).toEqual({ custom_rules: 8, rate_limit_rules: 2 });
    expect(VERCEL_PLAN_LIMITS.hobby).toEqual({
      customRules: 3,
      rateLimitRules: 1,
    });
    expect(fits).toEqual({ hobby: false, pro: true });
  });

  it("every rule name is one Vercel accepts (4 to 160 characters) and unique", () => {
    const names = vercelRules().map((r) => r.name);
    for (const n of names) expect(n.length, n).toBeGreaterThanOrEqual(4);
    for (const n of names) expect(n.startsWith("edge-"), n).toBe(true);
    for (const n of names) expect(n.length, n).toBeLessThanOrEqual(160);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the managed rule sets are declared, so an apply states them rather than dropping them", () => {
    expect(Object.keys(vercelFirewallConfig().managed_rulesets).sort()).toEqual(
      ["ai_bots", "bot_protection"],
    );
  });
});
