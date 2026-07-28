import type { HomepageFaq } from "./types";

/**
 * Marketing block — frequently asked questions (card 2.3.7).
 *
 * COPIED IN, NOT A DEPENDENCY. This file is OUR SOURCE now.
 *
 * Provenance: HyperUI — marketing/faqs
 *             https://github.com/markmead/hyperui
 *             public/examples/marketing/faqs/2.html
 * Fetched:    2026-07-28 · Licence: MIT (Copyright (c) Mark Mead)
 *
 * LOCAL MODIFICATIONS:
 *   - The source's neutral divider becomes the border token, its neutral-900
 *     question colour becomes the primary text token, and the answer body
 *     becomes the secondary text token. No raw hex. Utility names are
 *     deliberately not spelled out here — Tailwind scans comments as well as
 *     code, so naming a palette class would emit a dead hardcoded-colour rule
 *     into every app's stylesheet.
 *   - The source marks each question as an <h2>; here it is an <h3> under the
 *     section's <h2>, so the outline stays monotonic when this block sits
 *     alongside the others.
 *   - The first item is NOT force-opened (the source ships `open` on item one).
 *     A block whose first answer is expanded pushes the rest below the fold and
 *     reads as inconsistent when the section is composed in a different order.
 *
 * WHY <details>/<summary> AND NOT AN ACCORDION COMPONENT: it is the native
 * disclosure control — keyboard-operable, screen-reader-announced, and open by
 * default when JavaScript never runs. This block ships ZERO client JavaScript,
 * which matters on a landing page that must render on a serverless edge.
 */
export function FAQ({ faq }: { faq: HomepageFaq }) {
  if (faq.items.length === 0) {
    return null;
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <h2 className="text-center text-2xl font-semibold text-text-primary">
        {faq.heading}
      </h2>

      <div className="mt-8 flow-root">
        <div className="-my-4 flex flex-col divide-y divide-border">
          {faq.items.map((item, index) => (
            <details
              key={index}
              className="group py-4 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-1.5 text-text-primary">
                <h3 className="text-lg font-medium">{item.question}</h3>

                <svg
                  aria-hidden="true"
                  xmlns="http://www.w3.org/2000/svg"
                  className="size-5 shrink-0 transition-transform duration-300 group-open:-rotate-180"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </summary>

              <p className="pt-4 text-text-secondary">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
