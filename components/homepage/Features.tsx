import type { HomepageFeature } from "./types";

/**
 * Features section — a single centred column of benefit cards rendered from
 * content/homepage.json. Single-column (not a multi-column feature grid) is the
 * safe generic default: it reads mobile-first at every width and does not trip
 * the "no multi-column/enterprise feature grid on the landing page" anti-pattern
 * that per-app designs (e.g. K9Coach) document. Each feature title is an <h2>
 * (the hero's <h1> is the sole level-1 heading), so the document outline stays
 * monotonic for axe.
 */
export function Features({ features }: { features: HomepageFeature[] }) {
  if (features.length === 0) {
    return null;
  }
  return (
    <section className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <ul className="list-none space-y-4 p-0">
        {features.map((feature, index) => (
          <li
            key={index}
            className="rounded-lg border border-border bg-surface p-6"
          >
            <h2 className="text-lg font-semibold text-text-primary">
              {feature.title}
            </h2>
            <p className="mt-2 text-text-secondary">{feature.description}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
