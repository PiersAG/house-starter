// Terms of service (app-business-core issues 349, 350, 774). Public. The words are built in
// lib/legal/ from config/legal.ts, config/personal-data.ts and
// config/subprocessors.ts; docs/legal/ carries the same text for review.

import { LegalDocument } from "@/components/legal/LegalDocument";
import { termsOfService } from "@/lib/legal/contracts";

export const metadata = { title: "Terms of service", description: "The agreement for using the service." };

export default function Page() {
  return <LegalDocument doc={termsOfService()} />;
}
