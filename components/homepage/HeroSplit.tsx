import type { HomepageHeroSplit } from "./types";

/**
 * Marketing block — richer hero (card 2.3.7).
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now: it is reviewed in
 * ordinary PR diffs, it executes no install-time scripts, and it changes only
 * when we change it.
 *
 * Provenance: HyperUI — marketing/sections + marketing/ctas
 *             https://github.com/markmead/hyperui
 *             public/examples/marketing/sections/1.html
 * Fetched:    2026-07-28 · Licence: MIT (Copyright (c) Mark Mead)
 *
 * LOCAL MODIFICATIONS:
 *   - Every hardcoded Tailwind palette class replaced by a design token: the
 *     source's neutral-900 heading colour becomes the primary text token and
 *     its neutral-700 body colour becomes the secondary text token. No raw hex
 *     and no palette literals — the app's own tokens drive this block.
 *     (Utility names are deliberately NOT spelled out anywhere in this file:
 *     Tailwind scans comments as well as code, so naming a palette class here
 *     would emit a dead hardcoded-colour rule into every app's stylesheet.)
 *   - The source's two-column copy+image grid is reduced to a single centred
 *     column. Generated apps have no per-app image pipeline, and HyperUI's
 *     layout hangs on an <img> with an Unsplash src — shipping that would put a
 *     remote third-party image on every app's landing page.
 *   - Added eyebrow, secondary CTA and trust line, all optional and all fed
 *     from JSON, because those are the parts a small-business landing page
 *     actually varies.
 *   - Buttons use min-h-11 (44px) to hold the house touch-target rule, and
 *     text-primary-foreground rather than the source's literal white.
 *
 * The heading is the page's single <h1> — same contract as Hero.
 */
export function HeroSplit({ hero }: { hero: HomepageHeroSplit }) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
      {hero.eyebrow ? (
        <p className="text-sm font-medium uppercase tracking-wide text-text-secondary">
          {hero.eyebrow}
        </p>
      ) : null}

      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        {hero.heading}
      </h1>

      <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">
        {hero.subheading}
      </p>

      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <a
          href={hero.cta.href}
          className="inline-flex min-h-11 w-full items-center justify-center rounded bg-primary px-6 py-2 font-medium text-primary-foreground sm:w-auto"
        >
          {hero.cta.label}
        </a>

        {hero.secondaryCta ? (
          <a
            href={hero.secondaryCta.href}
            className="inline-flex min-h-11 w-full items-center justify-center rounded border border-border bg-surface px-6 py-2 font-medium text-text-primary sm:w-auto"
          >
            {hero.secondaryCta.label}
          </a>
        ) : null}
      </div>

      {hero.trustLine ? (
        <p className="mt-4 text-sm text-text-secondary">{hero.trustLine}</p>
      ) : null}
    </section>
  );
}
