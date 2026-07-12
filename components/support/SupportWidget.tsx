"use client";

/**
 * SupportWidget — chat widget shipped in house-starter, inherited by every app.
 * ADR-027 OQ3 + supporter spec deliverable D5.
 *
 * Mounts a fixed-position launcher button. On open, it shows a form: message +
 * "from" (defaults to the signed-in user's email if `defaultFrom` is passed).
 * POSTs a JSON query record to the shared /api/support endpoint on the
 * mothership (configured via NEXT_PUBLIC_SUPPORT_ENDPOINT). Renders a STUB
 * reply display — the real reply is delivered separately once the backend
 * (or a CEO-approved escalated reply) has been produced.
 *
 * The widget is deliberately dumb: no state, no dashboard, no fetch of past
 * queries. The Supporter agent lives on the mothership; this component only
 * captures a query.
 */

import { useState } from "react";

interface SupportWidgetProps {
  /** App id — must match state/apps/<id>/ on the mothership. */
  appId: string;
  /** Pre-fill the "from" field (typically the signed-in user's email). */
  defaultFrom?: string;
  /** Override endpoint. Defaults to NEXT_PUBLIC_SUPPORT_ENDPOINT. */
  endpoint?: string;
}

type Status = "closed" | "open" | "sending" | "sent" | "error";

export function SupportWidget({ appId, defaultFrom = "", endpoint }: SupportWidgetProps) {
  const [status, setStatus] = useState<Status>("closed");
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [error, setError] = useState<string | null>(null);
  const [queryId, setQueryId] = useState<string | null>(null);

  const target =
    endpoint ??
    (typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_SUPPORT_ENDPOINT ?? ""
      : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!target) {
      setError("Support endpoint not configured. Set NEXT_PUBLIC_SUPPORT_ENDPOINT.");
      setStatus("error");
      return;
    }
    if (!message.trim()) {
      setError("Please enter a message.");
      return;
    }
    setStatus("sending");
    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          channel: "widget",
          body: message.trim(),
          from: from.trim() || "anonymous",
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`${res.status}: ${t.slice(0, 200)}`);
      }
      const data = (await res.json()) as { query_id?: string };
      setQueryId(data.query_id ?? null);
      setStatus("sent");
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      setStatus("error");
    }
  }

  if (status === "closed") {
    return (
      <button
        type="button"
        onClick={() => setStatus("open")}
        aria-label="Open support"
        className="fixed bottom-4 right-4 z-50 min-h-11 min-w-11 rounded-full bg-blue-600 px-5 py-3 text-white shadow-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 sm:bottom-6 sm:right-6"
      >
        Support
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Support"
      className="fixed inset-x-4 bottom-4 z-50 rounded-xl border border-border bg-white p-4 shadow-xl sm:inset-x-auto sm:bottom-6 sm:right-6 sm:w-80"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">Get support</h3>
        <button
          type="button"
          onClick={() => {
            setStatus("closed");
            setError(null);
          }}
          aria-label="Close"
          className="flex h-11 w-11 items-center justify-center text-lg text-text-secondary hover:text-text-primary"
        >
          ×
        </button>
      </div>

      {status === "sent" ? (
        // STUB reply display (spec D5: "STUB reply display until backend
        // answers land"). The real reply comes via email or a later widget
        // enhancement; this confirms receipt only.
        <div className="space-y-2 text-sm text-text-primary">
          <p>Thanks — your message is with the team.</p>
          {queryId && (
            <p className="text-xs text-text-secondary">Reference: {queryId}</p>
          )}
          <p className="text-xs text-text-secondary">
            A reply will follow by email. Simple how-to questions may reply
            faster; anything touching money, data, or legal always goes to a
            human.
          </p>
          <button
            type="button"
            onClick={() => setStatus("open")}
            className="mt-2 text-xs text-blue-600 underline"
          >
            Send another message
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-text-secondary">
            Your email (optional)
            <input
              type="email"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs text-text-secondary">
            Message
            <textarea
              required
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What can we help with?"
              className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm"
            />
          </label>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={status === "sending"}
            className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-blue-300"
          >
            {status === "sending" ? "Sending…" : "Send"}
          </button>
        </form>
      )}
    </div>
  );
}
