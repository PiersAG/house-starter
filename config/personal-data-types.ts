// The shapes of the personal-data map (config/personal-data.ts), apart from its
// entries so each file stays readable. See that file for what the map is for.

import type { SubprocessorId } from "@/config/subprocessors";

export type LawfulBasis =
  | "contract"
  | "legal_obligation"
  | "legitimate_interests"
  | "consent";

/** What the deletion pipeline does to a table's rows when an account is erased. */
export type ErasureRule =
  /** The account's rows are deleted. */
  | { rule: "delete" }
  /** The rows stay (they count events, not people); these columns are cleared. */
  | { rule: "anonymise"; columns: string[] }
  /**
   * The law requires the business to keep the record: only `keep` fields are
   * copied to the retention layer (retained_records) with the legal reason and
   * an expiry, then the account's rows are deleted.
   */
  | { rule: "retain"; keep: string[]; legalBasis: string; years: number }
  /** The rows live in the account's own database, which is deleted whole. */
  | { rule: "tenant_database" }
  /**
   * The rows cannot be changed or removed (the audit trail, #796): they are the
   * evidence that the app followed its own rules. Kept for `years`, then removed
   * by the operator's yearly clean-up (docs/legal/retention-policy.md).
   */
  | { rule: "append_only"; years: number; why: string }
  /** The table holds nothing that identifies a person. */
  | { rule: "none" };

export interface DataMapEntry {
  /** Which database: the shared account database, or the account's own. */
  plane: "catalog" | "tenant";
  /** Columns that hold or point to a person (property names in lib/schema.ts). */
  personal: string[];
  /** The column that ties a row to one account (or null when none does). */
  linkedBy: string | null;
  /** What `linkedBy` holds: the account's id (the default), its database's id, or its Stripe customer id. */
  linkKind?: "userId" | "tenantId" | "stripeCustomerId";
  /** Plain-language category, as the privacy policy names it. */
  category: string;
  /** Exactly what it holds, in plain words (the privacy policy lists it). */
  holds: string;
  /** Why the app holds it, in plain words. */
  purpose: string;
  lawfulBasis: LawfulBasis;
  /** The outside services this data goes to. */
  processors: SubprocessorId[];
  /** How long it is kept while the account is open, in plain words. */
  retention: string;
  /** Rows older than this are deleted by the retention job, account open or not. */
  ageLimitDays?: number;
  /** The column `ageLimitDays` is measured on. */
  ageColumn?: string;
  onErasure: ErasureRule;
  /** For a column that looks personal but is not: why. */
  notPersonal?: Record<string, string>;
}

/** A place outside the app's database that personal data reaches. */
export interface OutsideLocation {
  id: string;
  /** Plain-language name. */
  name: string;
  what: string;
  processors: SubprocessorId[];
  /** How deletion reaches it. */
  deletion: string;
}

/** Plain words for a lawful basis, as the privacy policy names it. */
export function lawfulBasisLabel(b: LawfulBasis): string {
  switch (b) {
    case "contract":
      return "to provide the service you signed up for (contract)";
    case "legal_obligation":
      return "because the law requires it (legal obligation)";
    case "legitimate_interests":
      return "to keep the service secure and working (legitimate interests)";
    case "consent":
      return "because you agreed (consent)";
  }
}
