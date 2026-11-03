// Unsaved form text survives a session ending (app-business-core issue 525; Matt
// Murphy #153: "return to the original page after re-login with unsaved form data
// preserved").
//
// A form marked `data-keep-draft` has its typed values copied into this tab's
// sessionStorage when the session is about to end (the expiry warning), when the
// page is left, and put back when the page opens again — after the sign-in that
// returns the user to it. Never a password, a hidden field or a file. Only this
// tab can read sessionStorage, and the browser clears it when the tab closes.

const PREFIX = "draft:";
const SKIP = new Set(["password", "hidden", "file", "submit", "button", "reset", "image"]);

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function key(form: HTMLFormElement, index: number): string {
  return `${PREFIX}${window.location.pathname}:${form.id || form.getAttribute("name") || String(index)}`;
}

function fields(form: HTMLFormElement): Field[] {
  return Array.from(form.elements).filter(
    (el): el is Field =>
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) &&
      Boolean(el.name) &&
      !(el instanceof HTMLInputElement && SKIP.has(el.type)),
  );
}

/** Copy every marked form's typed values into this tab's storage. */
export function saveDrafts(doc: Document = document): number {
  let saved = 0;
  doc.querySelectorAll<HTMLFormElement>("form[data-keep-draft]").forEach((form, i) => {
    const values: Record<string, string | boolean> = {};
    for (const f of fields(form)) {
      values[f.name] = f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio") ? f.checked : f.value;
    }
    try {
      window.sessionStorage.setItem(key(form, i), JSON.stringify(values));
      saved += 1;
    } catch {
      // storage full or blocked: nothing to keep
    }
  });
  return saved;
}

/** Put saved values back into the marked forms on this page, then forget them. */
export function restoreDrafts(doc: Document = document): number {
  let restored = 0;
  doc.querySelectorAll<HTMLFormElement>("form[data-keep-draft]").forEach((form, i) => {
    let values: Record<string, string | boolean> | null = null;
    try {
      const raw = window.sessionStorage.getItem(key(form, i));
      values = raw ? (JSON.parse(raw) as Record<string, string | boolean>) : null;
      window.sessionStorage.removeItem(key(form, i));
    } catch {
      values = null;
    }
    if (!values) return;
    for (const f of fields(form)) {
      if (!(f.name in values)) continue;
      const v = values[f.name];
      if (f instanceof HTMLInputElement && (f.type === "checkbox" || f.type === "radio")) f.checked = v === true;
      else f.value = String(v);
      f.dispatchEvent(new Event("input", { bubbles: true }));
    }
    restored += 1;
  });
  return restored;
}
