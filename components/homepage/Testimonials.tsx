import type { HomepageTestimonials } from "./types";

/**
 * Marketing block — testimonials / social proof (card 2.3.7).
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now.
 *
 * Provenance: Meraki UI — components/testimonials/Card.html
 *             https://github.com/merakiui/merakiui
 * Fetched:    2026-07-28 · Licence: MIT (Copyright (c) 2021 Khatab Wedaa)
 *
 * LOCAL MODIFICATIONS:
 *   - All palette literals replaced by design tokens: the source's neutral
 *     quote colour (and its dark-mode variant) becomes the secondary text
 *     token, its bare border becomes the border token, and its white/neutral
 *     card background becomes the surface token. No raw hex. Utility names are
 *     deliberately not spelled out here — Tailwind scans comments as well as
 *     code, so naming a palette class would emit a dead hardcoded-colour rule
 *     into every app's stylesheet.
 *   - Avatar <img> removed. The source points every avatar at an Unsplash URL;
 *     generated apps have no per-app image pipeline, and a landing page must
 *     not depend on a remote third party to render.
 *   - The source's left/right carousel arrows are removed: they are decorative
 *     in the original (no JS is shipped with the snippet), and a button that
 *     does nothing fails the house accessibility bar.
 *   - The decorative underline bars are dropped — they hardcode a palette
 *     colour that has no token equivalent and carry no meaning.
 *   - <blockquote>/<cite> used instead of <p>/<div> so the quote attribution is
 *     semantic rather than visual.
 *
 * INTEGRITY: this block renders quotes; it never invents them. Nothing in the
 * factory generates testimonial content — see validate.ts and the card 2.3.7
 * report. A block with no real quotes should be omitted from homepage.json,
 * not filled with plausible-sounding ones.
 */
export function Testimonials({
  testimonials,
}: {
  testimonials: HomepageTestimonials;
}) {
  if (testimonials.items.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <h2 className="text-center text-2xl font-semibold text-text-primary">
        {testimonials.heading}
      </h2>

      <ul className="mt-8 grid list-none grid-cols-1 gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {testimonials.items.map((item, index) => (
          <li
            key={index}
            className="rounded-lg border border-border bg-surface p-6"
          >
            <blockquote className="text-text-secondary">
              {item.quote}
            </blockquote>
            <p className="mt-4 text-sm font-medium text-text-primary">
              <cite className="not-italic">{item.name}</cite>
              {item.role ? (
                <span className="block font-normal text-text-secondary">
                  {item.role}
                </span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
