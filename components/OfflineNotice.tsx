"use client";

// Offline notice (app-business-core issue 502; Matt Murphy video 297): a plain
// banner while the browser has no connection, gone when it is back. Announced
// politely to screen readers.

import { useEffect, useState } from "react";

export function OfflineNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 border-b border-border bg-accent px-4 py-2 text-center text-sm text-accent-foreground"
    >
      You are offline. Changes will not be saved until your connection is back.
    </div>
  );
}
