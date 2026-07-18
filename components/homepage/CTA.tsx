import type { HomepageClosingCta } from "./types";

/**
 * Closing call-to-action band — rendered from content/homepage.json. Sits on
 * the surface token (guaranteed AA against text-primary) with a filled primary
 * button, matching the house button pattern used by the auth forms. The heading
 * is an <h2>.
 */
export function CTA({ cta }: { cta: HomepageClosingCta }) {
  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="rounded-lg border border-border bg-surface px-6 py-12 text-center">
        <h2 className="text-2xl font-semibold text-text-primary">
          {cta.heading}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-text-secondary">
          {cta.subheading}
        </p>
        <div className="mt-6">
          <a
            href={cta.href}
            className="inline-flex min-h-11 items-center justify-center rounded bg-primary px-6 py-2 font-medium text-white"
          >
            {cta.label}
          </a>
        </div>
      </div>
    </section>
  );
}
