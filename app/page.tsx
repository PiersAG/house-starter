import type { Metadata } from "next";
import homepage from "@/content/homepage.json";
import { Hero } from "@/components/homepage/Hero";
import { Features } from "@/components/homepage/Features";
import { CTA } from "@/components/homepage/CTA";
import { FooterSection } from "@/components/homepage/FooterSection";
import type { HomepageContent } from "@/components/homepage/types";

// The homepage is a design-time slot: fixed section components rendering from
// content/homepage.json, which build-design.py generates per app from the
// product's name, value proposition, and feature set. No per-app code — only
// the JSON changes between apps. See wiki/reviews/2026-07-17-v0-graduation.md
// (Candidate 4).
const content = homepage as HomepageContent;

export const metadata: Metadata = {
  title: content.product,
  description: content.hero.subheading,
};

export default function Home() {
  return (
    <main>
      <Hero hero={content.hero} />
      <Features features={content.features} />
      <CTA cta={content.cta} />
      <FooterSection footer={content.footer} />
    </main>
  );
}
