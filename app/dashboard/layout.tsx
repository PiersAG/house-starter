// Dashboard segment layout — renders the primary nav ONCE for every page under
// /dashboard (the dashboard itself, settings, and any page added later).
//
// Nav used to be imported per page, so a new page under this segment rendered
// without it until someone remembered to add the import. Providing it here
// makes inheritance the default: adding a route under /dashboard cannot forget
// the nav, and the markup is never duplicated.

import type { ReactNode } from "react";
import { AppNav } from "@/components/AppNav";

export default function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <AppNav />
      {children}
    </>
  );
}
