// Writes the legal documents to docs/legal/ (app-business-core issues 349, 350,
// 774): the same text the app's pages show, for the CEO's review and the launch
// gate. Run after changing config/legal.ts, config/personal-data.ts or
// config/subprocessors.ts:
//
//   npm run legal:render
//
// tests/unit/legal-documents.test.ts fails when the committed files differ.

import "./server-only-node.cjs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { legalDocuments, toMarkdown } from "../lib/legal/render";

const dir = join(__dirname, "..", "docs", "legal");
for (const doc of legalDocuments()) {
  writeFileSync(join(dir, doc.file), toMarkdown(doc));
  console.log(`wrote docs/legal/${doc.file}`);
}
