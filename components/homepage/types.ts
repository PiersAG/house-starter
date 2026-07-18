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

export interface HomepageContent {
  /** Product name — used in metadata and the closing footer band. */
  product: string;
  hero: HomepageHero;
  features: HomepageFeature[];
  cta: HomepageClosingCta;
  footer: HomepageFooter;
}
