// Account segment layout — gives /account the same shell (and primary nav) as
// the dashboard segment. /account sits outside /dashboard, so it needs its own
// layout to inherit the shared nav; the markup itself lives once in AppNav.

import type { ReactNode } from "react";
import { AppNav } from "@/components/AppNav";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppNav />
      {children}
    </>
  );
}
