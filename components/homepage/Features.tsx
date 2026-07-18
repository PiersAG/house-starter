import type { HomepageFeature } from "./types";

/**
 * Features section — a responsive grid of benefit cards rendered from
 * content/homepage.json. Each feature title is an <h2> (the hero's <h1> is the
 * sole level-1 heading), so the document outline stays monotonic for axe.
 */
export function Features({ features }: { features: HomepageFeature[] }) {
  if (features.length === 0) {
    return null;
  }
  return (
    <section className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <ul className="grid list-none gap-6 p-0 sm:grid-cols-2 lg:grid-cols-3">
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
