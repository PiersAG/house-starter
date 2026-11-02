// One legal document as a page (app-business-core issues 349, 350, 774). The
// words come from lib/legal/, the same source `npm run legal:render` writes to
// docs/legal/, so the page and the reviewed file say the same thing. Until the
// CEO records a review in config/legal.ts the page says plainly that it is a
// draft template awaiting review; a recorded review removes that notice and
// never claims the text is legally checked.

import Link from "next/link";
import { REVIEW_NOTE, legalDetails } from "@/config/legal";
import type { LegalDocument as Doc } from "@/lib/legal/types";

export function LegalDocument({ doc }: { doc: Doc }) {
  const reviewed = legalDetails.review;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold text-text-primary">{doc.title}</h1>
      <p className="mt-2 text-sm text-text-secondary">Last updated {legalDetails.updated}.</p>
      {reviewed ? null : (
        <p role="note" className="mt-4 rounded border border-border bg-surface p-3 text-sm text-text-secondary">
          Draft. {REVIEW_NOTE}
        </p>
      )}
      <p className="mt-4 text-text-secondary">{doc.summary}</p>
      {doc.sections.map((s) => (
        <section key={s.heading} className="mt-8">
          <h2 className="text-lg font-semibold text-text-primary">{s.heading}</h2>
          {(s.paragraphs ?? []).map((p) => (
            <p key={p} className="mt-3 text-text-secondary">
              {p}
            </p>
          ))}
          {s.bullets?.length ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-text-secondary">
              {s.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
      <nav aria-label="Legal documents" className="mt-12 flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <Link href="/privacy" className="font-medium text-link underline">Privacy policy</Link>
        <Link href="/terms" className="font-medium text-link underline">Terms of service</Link>
        <Link href="/subprocessors" className="font-medium text-link underline">Subprocessors</Link>
        <Link href="/legal/dpa" className="font-medium text-link underline">Data processing agreement</Link>
        <Link href="/legal/service-agreement" className="font-medium text-link underline">Service agreement</Link>
      </nav>
    </main>
  );
}
