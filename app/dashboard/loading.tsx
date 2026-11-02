// Route-level loading screen for the signed-in area (app-business-core issue
// 502): shown while a dashboard page loads, instead of a blank screen.

import { LoadingSpinner } from "@/components/ui/LoadingSpinner";

export default function DashboardLoading() {
  return <LoadingSpinner label="Loading…" />;
}
