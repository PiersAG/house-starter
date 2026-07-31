// Account segment layout — gives /account the same shell (and primary nav) as
// the dashboard segment. /account sits outside /dashboard, so it needs its own
// layout to inherit the shared nav; the markup itself lives once in AppNav.

import type { ReactNode } from "react";
import { AppNav } from "@/components/AppNav";

export default function AccountLayout({ children }: { children: ReactNode }) {
  // Same container context as the dashboard segment — see that file and
  // docs/responsive.md. A context only: it sets no width and moves nothing.
  // Same as the dashboard segment: clear the fixed bottom tab bar at narrow
  // widths, drop the padding at `roomy` where the nav returns to the top.
  // Same boundary name as AppNav switches on, asserted by a test.
  return (
    <div className="@container/page">
      <AppNav />
      <div className="pb-24 @roomy/page:pb-0">{children}</div>
    </div>
  );
}
