/**
 * Homepage content contract — the design-time slot (Candidate 4, v0
 * graduation 2026-07-17).
 *
 * app/page.tsx renders a fixed set of section components (Hero, Features, CTA,
 * FooterSection) from content/homepage.json. build-design.py emits that JSON at
 * design time, populated from the app's product name, value proposition, and
 * feature set. The template ships a default content/homepage.json so CI renders
 * and the axe/responsive gates stay green. Iteration regenerates the JSON only
 * — no per-app code change.
 *
 * EXTENDED by card 2.3.7 with marketing blocks (heroSplit, testimonials,
 * pricing, faq) and an optional `sections` array that makes ORDER and PRESENCE
 * data too. The four original sections and the original fixed-order rendering
 * are untouched: a homepage.json without `sections` renders exactly as before.
 */

export interface HomepageCta {
  /** Button label, e.g. "Get started". */
  label: string;
  /** Where the button links. Defaults to the signup route. */
  href: string;
}

export interface HomepageHero {
  heading: string;
  subheading: string;
  /** The hero's primary call-to-action button. */
  cta: HomepageCta;
}

export interface HomepageFeature {
  title: string;
  description: string;
}

export interface HomepageClosingCta {
  heading: string;
  subheading: string;
  label: string;
  href: string;
}

export interface HomepageFooter {
  tagline: string;
}

/* ── Marketing blocks (card 2.3.7) ────────────────────────────────────────
 *
 * Added alongside the four original sections, not in place of them. Every
 * block below is OPTIONAL and every one is driven entirely by JSON, so the
 * control centre (2.3.9) can compose a landing page by writing data — a
 * serverless-safe operation with no code generation.
 */

/** A richer hero: the original plus an eyebrow, a second CTA and a trust line. */
export interface HomepageHeroSplit {
  /** Small label above the heading, e.g. "For solo trainers". Optional. */
  eyebrow?: string;
  heading: string;
  subheading: string;
  cta: HomepageCta;
  /** Optional secondary, lower-emphasis action, e.g. "See how it works". */
  secondaryCta?: HomepageCta;
  /** Optional one-line reassurance under the buttons, e.g. trial terms. */
  trustLine?: string;
}

export interface HomepageTestimonial {
  /** The customer's own words. Never generate these — see validate.ts. */
  quote: string;
  /** Who said it. */
  name: string;
  /** Their role or business. Optional. */
  role?: string;
}

export interface HomepageTestimonials {
  heading: string;
  items: HomepageTestimonial[];
}

export interface HomepagePricingPlan {
  name: string;
  /** Formatted price INCLUDING currency, e.g. "£29". Never inferred. */
  price: string;
  /** Billing period shown next to the price, e.g. "/month". Optional. */
  period?: string;
  /** One-line positioning under the plan name. Optional. */
  description?: string;
  /** What the plan includes — rendered as a checked list. */
  features: string[];
  cta: HomepageCta;
  /** Marks the recommended plan; renders with a primary ring. */
  featured?: boolean;
}

export interface HomepagePricing {
  heading: string;
  subheading?: string;
  plans: HomepagePricingPlan[];
}

export interface HomepageFaqItem {
  question: string;
  answer: string;
}

export interface HomepageFaq {
  heading: string;
  items: HomepageFaqItem[];
}

/**
 * A composable section. `type` is the discriminant the renderer switches on;
 * because the union is closed, adding a block without handling it in
 * app/page.tsx is a COMPILE error, not a runtime surprise.
 */
export type HomepageSection =
  | { type: "hero"; content: HomepageHero }
  | { type: "heroSplit"; content: HomepageHeroSplit }
  | { type: "features"; content: HomepageFeature[] }
  | { type: "testimonials"; content: HomepageTestimonials }
  | { type: "pricing"; content: HomepagePricing }
  | { type: "faq"; content: HomepageFaq }
  | { type: "cta"; content: HomepageClosingCta }
  | { type: "footer"; content: HomepageFooter };

/** Every block type the renderer understands. Single source of truth. */
export const HOMEPAGE_SECTION_TYPES = [
  "hero",
  "heroSplit",
  "features",
  "testimonials",
  "pricing",
  "faq",
  "cta",
  "footer",
] as const;

export type HomepageSectionType = (typeof HOMEPAGE_SECTION_TYPES)[number];

export interface HomepageContent {
  /** Product name — used in metadata and the closing footer band. */
  product: string;
  hero: HomepageHero;
  features: HomepageFeature[];
  cta: HomepageClosingCta;
  footer: HomepageFooter;
  /**
   * OPTIONAL composition. When present, app/page.tsx renders exactly these
   * sections in exactly this order. When absent, it renders the original
   * fixed order (hero → features → cta → footer), so every homepage.json
   * written before this card keeps rendering unchanged.
   */
  sections?: HomepageSection[];
}
