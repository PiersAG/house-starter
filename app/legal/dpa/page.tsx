// Data processing agreement (app-business-core issues 349, 350, 774). Public. The words are built in
// lib/legal/ from config/legal.ts, config/personal-data.ts and
// config/subprocessors.ts; docs/legal/ carries the same text for review.

import { LegalDocument } from "@/components/legal/LegalDocument";
import { customerDpa } from "@/lib/legal/contracts";

export const metadata = { title: "Data processing agreement", description: "Who is responsible for what when a business keeps its customers' data in the app." };

export default function Page() {
  return <LegalDocument doc={customerDpa()} />;
}
