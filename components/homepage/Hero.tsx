import type { HomepageHero } from "./types";

/**
 * Hero section — the top band of the homepage slot. Renders the product's
 * headline, sub-headline, and primary call-to-action from content/homepage.json.
 * The heading is the page's single <h1>.
 */
export function Hero({ hero }: { hero: HomepageHero }) {
  return (
    <section className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
        {hero.heading}
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-lg text-text-secondary">
        {hero.subheading}
      </p>
      <div className="mt-8">
        <a
          href={hero.cta.href}
          className="inline-flex min-h-11 items-center justify-center rounded bg-primary px-6 py-2 font-medium text-white"
        >
          {hero.cta.label}
        </a>
      </div>
    </section>
  );
}
