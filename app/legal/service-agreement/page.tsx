// Service agreement (app-business-core issues 349, 350, 774). Public. The words are built in
// lib/legal/ from config/legal.ts, config/personal-data.ts and
// config/subprocessors.ts; docs/legal/ carries the same text for review.

import { LegalDocument } from "@/components/legal/LegalDocument";
import { serviceAgreement } from "@/lib/legal/contracts";

export const metadata = { title: "Service agreement", description: "Support, availability and response times." };

export default function Page() {
  return <LegalDocument doc={serviceAgreement()} />;
}
