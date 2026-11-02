// The shape every legal document is built in: a title and ordered sections of
// paragraphs and bullet lists. lib/legal/render.ts writes it as markdown
// (docs/legal/) and components/legal/LegalDocument.tsx shows it as a page, so
// the page and the reviewed file can never say different things.

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  /** The page address, e.g. "/privacy". */
  path: string;
  /** The docs/legal/ file it is written to, e.g. "privacy-policy.md". */
  file: string;
  title: string;
  /** One line under the title: what the document is for. */
  summary: string;
  sections: LegalSection[];
}
