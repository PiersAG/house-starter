import type { HomepageFooter } from "./types";

/**
 * Closing footer band for the homepage. Deliberately a <section>, NOT a
 * <footer>: app/layout.tsx already renders the page's single <footer>
 * (contentinfo) landmark, and a second top-level <footer> would trip axe's
 * duplicate-contentinfo rule and fail the blocking accessibility gate. This is
 * a content band that closes the marketing page; the real site footer lives in
 * the layout.
 */
export function FooterSection({ footer }: { footer: HomepageFooter }) {
  return (
    <section className="border-t border-border px-4 py-8 text-center">
      <p className="text-sm text-text-secondary">{footer.tagline}</p>
    </section>
  );
}
