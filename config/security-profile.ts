// Per-app facts for the public security page and security.txt
// (PiersAG/app-business-core#524, Matt Murphy #151).
//
// What the template itself guarantees is written in lib/security-page.ts and
// is true of every app built from it. The facts below differ per app — where
// its data lives, how its database is backed up — so the per-app build sets
// them. While one is unset (null) the page says so plainly and points to the
// security contact; it never claims something the app has not configured.

export interface SecurityProfile {
  /** Where customer data is stored, e.g. "Turso, AWS eu-west-2 (London)". */
  dataLocation: string | null;
  /** How the database is backed up and for how long copies are kept. */
  backups: string | null;
  /**
   * Where security reports go. Falls back to SECURITY_CONTACT_EMAIL, then to
   * NEXT_PUBLIC_SUPPORT_EMAIL, read at request time.
   */
  contactEmail: string | null;
}

export const SECURITY_PROFILE: SecurityProfile = {
  dataLocation: null,
  backups: null,
  contactEmail: null,
};
