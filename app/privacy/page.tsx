// Privacy policy (app-business-core issues 349, 350, 774). Public. The words are built in
// lib/legal/ from config/legal.ts, config/personal-data.ts and
// config/subprocessors.ts; docs/legal/ carries the same text for review.

import { LegalDocument } from "@/components/legal/LegalDocument";
import { privacyPolicy } from "@/lib/legal/privacy-policy";

export const metadata = { title: "Privacy policy", description: "What personal data is collected, why, where it goes, how long it is kept and how to delete it." };

export default function Page() {
  return <LegalDocument doc={privacyPolicy()} />;
}
