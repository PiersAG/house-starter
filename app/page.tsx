import type { Metadata } from "next";
import homepage from "@/content/homepage.json";
import { Hero } from "@/components/homepage/Hero";
import { Features } from "@/components/homepage/Features";
import { CTA } from "@/components/homepage/CTA";
import { FooterSection } from "@/components/homepage/FooterSection";
import { Sections } from "@/components/homepage/Sections";
import type { HomepageContent } from "@/components/homepage/types";

// The homepage is a design-time slot: section components rendering from
// content/homepage.json, which build-design.py generates per app from the
// product's name, value proposition, and feature set. No per-app code — only
// the JSON changes between apps. See wiki/reviews/2026-07-17-v0-graduation.md
// (Candidate 4).
//
// Card 2.3.7 made COMPOSITION data too. When homepage.json carries a `sections`
// array, the page is exactly those blocks in exactly that order — so the
// control centre (2.3.9) can compose a landing page by writing JSON, with no
// code generation. When it does not, the original fixed order renders
// unchanged, which is why every homepage.json written before 2.3.7 still works.
//
// The JSON's SHAPE is checked by tests/unit/homepage-content.test.ts via
// components/homepage/validate.ts — the cast below is a promise to the
// compiler, and that test is what keeps the promise.
const content = homepage as HomepageContent;

export const metadata: Metadata = {
  title: content.product,
  description: content.hero.subheading,
};

export default function Home() {
  return (
    <main>
      {content.sections ? (
        <Sections sections={content.sections} />
      ) : (
        <>
          <Hero hero={content.hero} />
          <Features features={content.features} />
          <CTA cta={content.cta} />
          <FooterSection footer={content.footer} />
        </>
      )}
    </main>
  );
}
