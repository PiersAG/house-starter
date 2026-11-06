// SEEDED FLAW — NEVER PART OF THE APP. The active scan's self-test
// (.github/workflows/active-scan-selftest.yml) copies this file to
// app/dashboard/canary/page.tsx in its own throwaway checkout, builds, scans,
// and passes only if the scan raises a High finding here (app-business-core
// issue 533 acceptance: "a seeded XSS flaw behind login is caught").
//
// The flaw: a SIGNED-IN page that echoes its `q` query into the HTML without
// escaping (reflected cross-site scripting). The dashboard does not link here,
// so the plan names this page as a spider start when the self-test asks.
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function CanaryPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const q = (await searchParams).q ?? "";
  return (
    <main>
      <form method="get" action="/dashboard/canary">
        <label htmlFor="q">Search</label>
        <input id="q" name="q" defaultValue="hello" />
        <button type="submit">Search</button>
      </form>
      <div dangerouslySetInnerHTML={{ __html: `<p>You searched for: ${q}</p>` }} />
    </main>
  );
}
