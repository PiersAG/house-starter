import { describe, it, expect } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });
  it("filters falsy values", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });
  it("resolves tailwind conflicts — last class wins", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("handles conditional objects", () => {
    expect(cn({ "text-red-500": true, "text-blue-500": false })).toBe(
      "text-red-500",
    );
  });
});
