"use client";

// One editable (or locked) setting row for the generated settings UI. Renders
// an input appropriate to the value_type, persists via PUT /api/settings/[key],
// and reverts via DELETE. Factory-locked settings (owner_editable = false)
// render read-only with a badge. This is a generic control — it is NOT a
// per-capability hand-built screen (settings-registry-spec §5).

import { useState } from "react";
import type { EffectiveSetting } from "@/lib/settings/service";

type Scope = "owner" | "client";

function displayValue(v: unknown): string {
  if (typeof v === "string") return v === "" ? "—" : v;
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const SOURCE_LABEL: Record<string, string> = {
  factory: "Factory default",
  owner: "Set by you",
  client: "Your preference",
};

export function SettingControl({
  setting,
  scope,
}: {
  setting: EffectiveSetting;
  scope: Scope;
}) {
  const [value, setValue] = useState<unknown>(setting.effectiveValue);
  const [source, setSource] = useState(setting.source);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(next: unknown) {
    setStatus("saving");
    setError(null);
    const res = await fetch(`/api/settings/${encodeURIComponent(setting.key)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: next, scope }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not save.");
      setStatus("error");
      return;
    }
    setValue(next);
    setSource(scope);
    setStatus("idle");
  }

  async function reset() {
    setStatus("saving");
    setError(null);
    await fetch(
      `/api/settings/${encodeURIComponent(setting.key)}?scope=${scope}`,
      { method: "DELETE" },
    );
    setStatus("idle");
    // Reload so the freshly resolved (fallen-through) value is shown.
    window.location.reload();
  }

  const inputId = `setting-${setting.key}`;

  return (
    <div className="flex flex-col gap-1 border-b border-border py-4 last:border-b-0">
      <div className="flex items-center justify-between gap-4">
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {setting.label}
        </label>
        <span className="shrink-0 text-xs text-text-secondary">
          {setting.locked ? "Factory-locked" : SOURCE_LABEL[source] ?? source}
        </span>
      </div>
      <p className="text-sm text-text-secondary">{setting.description}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {setting.locked ? (
          <span className="rounded border border-border bg-surface px-2 py-1 text-sm text-text-primary">
            {displayValue(value)}
          </span>
        ) : (
          <Editor
            id={inputId}
            setting={setting}
            value={value}
            disabled={status === "saving"}
            onCommit={save}
          />
        )}

        {!setting.locked && source !== "factory" && (
          <button
            type="button"
            onClick={reset}
            disabled={status === "saving"}
            className="min-h-9 rounded border border-border px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Reset to default
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function Editor({
  id,
  setting,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  setting: EffectiveSetting;
  value: unknown;
  disabled: boolean;
  onCommit: (v: unknown) => void;
}) {
  const base =
    "min-h-11 rounded border border-border bg-surface px-2 py-1 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";

  if (setting.valueType === "boolean") {
    return (
      <input
        id={id}
        type="checkbox"
        checked={value === true}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.checked)}
        className="h-5 w-5"
      />
    );
  }

  if (setting.valueType === "enum") {
    // pr-8 reserves room for the native dropdown arrow so the value text (e.g.
    // "GBP") never sits under it. pl-2 (not the shared px-2) keeps the left
    // padding without a px-2/pr-8 right-padding conflict. Applies to every enum
    // select, not just currency.
    const selectClasses =
      "min-h-11 rounded border border-border bg-surface pl-2 pr-8 py-1 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary";
    return (
      <select
        id={id}
        defaultValue={String(value ?? "")}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value)}
        className={selectClasses}
      >
        {(setting.enumValues ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }

  if (
    setting.valueType === "integer" ||
    setting.valueType === "decimal" ||
    setting.valueType === "duration_hours"
  ) {
    return (
      <input
        id={id}
        type="number"
        defaultValue={typeof value === "number" ? value : ""}
        min={setting.bounds?.min}
        max={setting.bounds?.max}
        step={setting.valueType === "decimal" ? "any" : 1}
        disabled={disabled}
        onBlur={(e) => {
          if (e.target.value === "") return;
          onCommit(Number(e.target.value));
        }}
        className={`${base} w-28`}
      />
    );
  }

  if (setting.valueType === "json") {
    return (
      <textarea
        id={id}
        defaultValue={JSON.stringify(value)}
        disabled={disabled}
        onBlur={(e) => {
          try {
            onCommit(JSON.parse(e.target.value));
          } catch {
            /* leave to server validation on next valid edit */
          }
        }}
        className={`${base} w-full font-mono`}
        rows={2}
      />
    );
  }

  // text
  return (
    <input
      id={id}
      type="text"
      defaultValue={typeof value === "string" ? value : ""}
      disabled={disabled}
      onBlur={(e) => onCommit(e.target.value)}
      className={`${base} w-full max-w-sm`}
    />
  );
}
