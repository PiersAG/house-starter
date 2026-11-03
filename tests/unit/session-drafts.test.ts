// @vitest-environment jsdom
// Unsaved form text survives a session ending (app-business-core issue 525; Matt
// Murphy step 153: "return to the original page after re-login with unsaved form
// data preserved").

import { beforeEach, describe, expect, it } from "vitest";
import { restoreDrafts, saveDrafts } from "@/lib/session/drafts";

function page(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="note" data-keep-draft>
      <input name="title" />
      <textarea name="body"></textarea>
      <input name="urgent" type="checkbox" />
      <input name="secret" type="password" />
      <input name="csrf" type="hidden" value="x" />
    </form>
    <form id="other"><input name="ignored" /></form>`;
  return document.getElementById("note") as HTMLFormElement;
}

beforeEach(() => window.sessionStorage.clear());

describe("#525 drafts", () => {
  it("keeps typed text, never a password or a hidden field, and puts it back once", () => {
    const form = page();
    (form.elements.namedItem("title") as HTMLInputElement).value = "Session notes";
    (form.elements.namedItem("body") as HTMLTextAreaElement).value = "Rex did well";
    (form.elements.namedItem("urgent") as HTMLInputElement).checked = true;
    (form.elements.namedItem("secret") as HTMLInputElement).value = "hunter2";
    expect(saveDrafts()).toBe(1);
    const stored = JSON.stringify(Object.fromEntries(Object.entries(window.sessionStorage)));
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("ignored");

    const again = page(); // the page opens again after signing in
    expect(restoreDrafts()).toBe(1);
    expect((again.elements.namedItem("title") as HTMLInputElement).value).toBe("Session notes");
    expect((again.elements.namedItem("body") as HTMLTextAreaElement).value).toBe("Rex did well");
    expect((again.elements.namedItem("urgent") as HTMLInputElement).checked).toBe(true);
    expect((again.elements.namedItem("secret") as HTMLInputElement).value).toBe("");
    expect(restoreDrafts()).toBe(0); // forgotten once restored
  });
});
