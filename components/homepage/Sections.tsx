import { Hero } from "./Hero";
import { HeroSplit } from "./HeroSplit";
import { Features } from "./Features";
import { Testimonials } from "./Testimonials";
import { Pricing } from "./Pricing";
import { FAQ } from "./FAQ";
import { CTA } from "./CTA";
import { FooterSection } from "./FooterSection";
import type { HomepageSection } from "./types";

/**
 * Composition renderer (card 2.3.7) — turns the `sections` array from
 * content/homepage.json into the page.
 *
 * The switch is EXHAUSTIVE over the HomepageSection union. Adding a block type
 * to types.ts without adding a case here is a COMPILE error, not a page that
 * silently drops a section: the `never` assignment at the end is what enforces
 * it. That is the "an unknown block cannot ship" guarantee at the type level;
 * validate.ts enforces the same thing for the JSON at runtime.
 */
export function renderSection(section: HomepageSection, key: number) {
  switch (section.type) {
    case "hero":
      return <Hero key={key} hero={section.content} />;
    case "heroSplit":
      return <HeroSplit key={key} hero={section.content} />;
    case "features":
      return <Features key={key} features={section.content} />;
    case "testimonials":
      return <Testimonials key={key} testimonials={section.content} />;
    case "pricing":
      return <Pricing key={key} pricing={section.content} />;
    case "faq":
      return <FAQ key={key} faq={section.content} />;
    case "cta":
      return <CTA key={key} cta={section.content} />;
    case "footer":
      return <FooterSection key={key} footer={section.content} />;
    default: {
      // Unreachable while the union and this switch agree. If a future block
      // type is added to types.ts and not handled above, `section` is no longer
      // `never` here and the build fails.
      const exhaustive: never = section;
      return exhaustive;
    }
  }
}

export function Sections({ sections }: { sections: HomepageSection[] }) {
  return <>{sections.map((section, i) => renderSection(section, i))}</>;
}
