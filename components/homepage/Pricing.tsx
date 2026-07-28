import type { HomepagePricing } from "./types";

/**
 * Marketing block — pricing (card 2.3.7).
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now.
 *
 * Provenance: HyperUI — marketing/pricing
 *             https://github.com/markmead/hyperui
 *             public/examples/marketing/pricing/1.html
 * Fetched:    2026-07-28 · Licence: MIT (Copyright (c) Mark Mead)
 *
 * LOCAL MODIFICATIONS:
 *   - The source's indigo highlight (its border, ring and check-icon colour) is
 *     replaced by the primary token, so the recommended plan is highlighted in
 *     the APP'S brand colour rather than HyperUI's.
 *   - The source's neutral-900 and neutral-700 text colours become the primary
 *     and secondary text tokens. No raw hex. Utility names are deliberately not
 *     spelled out here — Tailwind scans comments as well as code, so naming a
 *     palette class would emit a dead hardcoded-colour rule into every app's
 *     stylesheet.
 *   - The source hardcodes a two-plan layout with sm:order-last to float the
 *     featured plan; plans are data here, so the grid is driven by count and
 *     the featured plan is marked by a ring rather than by DOM order (reordering
 *     visually but not in the DOM is a screen-reader trap).
 *   - Feature list keeps the source's check-icon pattern; the inline SVG is
 *     aria-hidden with the meaning carried by the adjacent text.
 *   - Plan name is an <h3> (the section heading is the <h2>) so the document
 *     outline stays monotonic for axe.
 *
 * INTEGRITY: `price` is a formatted string supplied in JSON, never derived or
 * guessed. The repo holds Stripe price IDs, not human-readable amounts — a
 * price shown here must come from a human who knows what the product costs.
 */
export function Pricing({ pricing }: { pricing: HomepagePricing }) {
  if (pricing.plans.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <h2 className="text-center text-2xl font-semibold text-text-primary">
        {pricing.heading}
      </h2>

      {pricing.subheading ? (
        <p className="mx-auto mt-3 max-w-xl text-center text-text-secondary">
          {pricing.subheading}
        </p>
      ) : null}

      <ul
        className={`mt-8 grid list-none grid-cols-1 gap-6 p-0 ${
          pricing.plans.length > 1 ? "sm:grid-cols-2" : "mx-auto max-w-md"
        }`}
      >
        {pricing.plans.map((plan, index) => (
          <li
            key={index}
            className={`rounded-2xl border bg-surface p-6 sm:px-8 ${
              plan.featured
                ? "border-primary ring-1 ring-primary"
                : "border-border"
            }`}
          >
            <div className="text-center">
              <h3 className="text-lg font-medium text-text-primary">
                {plan.name}
              </h3>

              <p className="mt-2 sm:mt-4">
                <strong className="text-3xl font-bold text-text-primary sm:text-4xl">
                  {plan.price}
                </strong>
                {plan.period ? (
                  <span className="text-sm font-medium text-text-secondary">
                    {plan.period}
                  </span>
                ) : null}
              </p>

              {plan.description ? (
                <p className="mt-2 text-sm text-text-secondary">
                  {plan.description}
                </p>
              ) : null}
            </div>

            <ul className="mt-6 list-none space-y-2 p-0">
              {plan.features.map((feature, featureIndex) => (
                <li key={featureIndex} className="flex items-start gap-2">
                  <svg
                    aria-hidden="true"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="mt-0.5 size-5 shrink-0 text-primary"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4.5 12.75l6 6 9-13.5"
                    />
                  </svg>
                  <span className="text-text-secondary">{feature}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8">
              <a
                href={plan.cta.href}
                className={`inline-flex min-h-11 w-full items-center justify-center rounded px-6 py-2 font-medium ${
                  plan.featured
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-text-primary"
                }`}
              >
                {plan.cta.label}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
