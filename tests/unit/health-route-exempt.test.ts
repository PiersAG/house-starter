import { describe, expect, it } from "vitest";
import {
  capabilityForPath,
  isPathDisabledByCapability,
} from "@/lib/capabilities/routes";

// Pins the invariant that /api/health is a CORE route: it belongs to no
// capability and is therefore never 404'd by the capability middleware, with
// every flag OFF (the default posture). If a future change adds a capability
// prefix that swallows /api/health, this fails loudly rather than the external
// prober silently going dark.
describe("/api/health is core and never capability-gated", () => {
  it("belongs to no capability", () => {
    expect(capabilityForPath("/api/health")).toBeNull();
  });

  it("is not disabled by any OFF capability (all flags off by default)", () => {
    expect(isPathDisabledByCapability("/api/health")).toBe(false);
  });
});
