"use client";

// The plain-language consent question (app-business-core issue 745; Matt
// Murphy step 203: "users should understand what they're agreeing to in plain
// language before the data moves anywhere"). Shown only when a page lists a
// third-party script that reads personal data and the person has not answered.
// Nothing is pre-ticked: "Yes" sets the cookie and reloads so the script loads;
// "No" records nothing and the script never loads.

import { useState } from "react";
import { CONSENT_COOKIE, consentValue, parseConsent } from "@/lib/privacy/consent";

export function ConsentPrompt({ names, questions }: { names: string[]; questions: string[] }) {
  const [hidden, setHidden] = useState(false);
  const items = names.map((name, i) => ({ name, question: questions[i] ?? "" }));
  if (hidden || items.length === 0) return null;
  const agree = () => {
    const current = parseConsent(document.cookie.match(/(?:^|; )consent=([^;]*)/)?.[1]);
    for (const i of items) current.add(i.name);
    document.cookie = `${CONSENT_COOKIE}=${consentValue(current)}; path=/; max-age=31536000; samesite=lax; secure`;
    window.location.reload();
  };
  return (
    <div role="dialog" aria-label="Your choice about outside services" className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface p-4">
      <div className="mx-auto max-w-2xl space-y-2 text-sm text-text-primary">
        {items.map((i) => (
          <p key={i.name}>
            <strong>{i.name}:</strong> {i.question}
          </p>
        ))}
        <div className="flex gap-3">
          <button type="button" onClick={agree} className="min-h-11 rounded bg-primary px-4 py-2 font-medium text-primary-foreground">
            Yes, allow it
          </button>
          <button type="button" onClick={() => setHidden(true)} className="min-h-11 rounded border border-border px-4 py-2 font-medium text-text-primary">
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
