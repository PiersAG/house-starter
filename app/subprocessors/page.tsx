// Subprocessors (app-business-core issues 349, 350, 774). Public. The words are built in
// lib/legal/ from config/legal.ts, config/personal-data.ts and
// config/subprocessors.ts; docs/legal/ carries the same text for review.

import { LegalDocument } from "@/components/legal/LegalDocument";
import { subprocessorList } from "@/lib/legal/privacy-policy";

export const metadata = { title: "Subprocessors", description: "The outside services that handle data for this app." };

export default function Page() {
  return <LegalDocument doc={subprocessorList()} />;
}
