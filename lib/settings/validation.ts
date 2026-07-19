// Settings validation (settings-registry-spec §3 · "writes validated against
// value_type/bounds/owner_editable at the API layer; unknown keys rejected").
//
// Pure functions over a definition + a candidate value. No I/O — the API route
// and any server action call these before writing. A rejection carries a
// machine code and a plain-English message (CEO-readable outputs rule).

import type { SettingDefinition } from "@/lib/settings/types";
import { getDefinition } from "@/lib/settings/registry";

export type ValidationCode =
  | "unknown_key"
  | "not_owner_editable"
  | "wrong_type"
  | "out_of_bounds"
  | "not_an_allowed_option";

export interface ValidationError {
  ok: false;
  code: ValidationCode;
  message: string;
}
export interface ValidationOk {
  ok: true;
  /** The accepted value (unchanged; validation does not coerce). */
  value: unknown;
}
export type ValidationResult = ValidationOk | ValidationError;

function fail(code: ValidationCode, message: string): ValidationError {
  return { ok: false, code, message };
}

/** Numeric-typed settings that honour `bounds`. */
const NUMERIC_TYPES = new Set(["integer", "decimal", "duration_hours"]);

/**
 * Validate a candidate value for a definition against its value_type, enum
 * membership and numeric bounds. Does NOT check owner_editable — that is a
 * scope concern handled by validateOwnerWrite.
 */
export function validateValue(
  def: SettingDefinition,
  value: unknown,
): ValidationResult {
  switch (def.valueType) {
    case "boolean":
      if (typeof value !== "boolean") {
        return fail("wrong_type", `${def.label} must be true or false.`);
      }
      return { ok: true, value };

    case "text":
      if (typeof value !== "string") {
        return fail("wrong_type", `${def.label} must be text.`);
      }
      return { ok: true, value };

    case "enum": {
      if (typeof value !== "string") {
        return fail("wrong_type", `${def.label} must be one of the allowed options.`);
      }
      const allowed = def.enumValues ?? [];
      if (!allowed.includes(value)) {
        return fail(
          "not_an_allowed_option",
          `${def.label} must be one of: ${allowed.join(", ")}.`,
        );
      }
      return { ok: true, value };
    }

    case "integer":
    case "duration_hours":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return fail("wrong_type", `${def.label} must be a whole number.`);
      }
      return checkBounds(def, value);

    case "decimal":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return fail("wrong_type", `${def.label} must be a number.`);
      }
      return checkBounds(def, value);

    case "json":
      // Any JSON-serialisable value is accepted; the definition owns its shape.
      if (value === undefined) {
        return fail("wrong_type", `${def.label} must be provided.`);
      }
      return { ok: true, value };

    default:
      // Unreachable while value_type is exhaustive; guards a future value_type
      // added to the type without a validation arm.
      return fail("wrong_type", `${def.label} has an unsupported value type.`);
  }
}

function checkBounds(def: SettingDefinition, value: number): ValidationResult {
  if (!NUMERIC_TYPES.has(def.valueType) || !def.bounds) {
    return { ok: true, value };
  }
  const { min, max } = def.bounds;
  if (typeof min === "number" && value < min) {
    return fail("out_of_bounds", `${def.label} must be at least ${min}.`);
  }
  if (typeof max === "number" && value > max) {
    return fail("out_of_bounds", `${def.label} must be at most ${max}.`);
  }
  return { ok: true, value };
}

/**
 * Full validation for an OWNER write to `key`: unknown-key rejection,
 * owner_editable enforcement, then value validation. The single entry point the
 * API route uses for a PUT.
 */
export function validateOwnerWrite(key: string, value: unknown): ValidationResult {
  const def = getDefinition(key);
  if (!def) {
    return fail("unknown_key", `Unknown setting "${key}".`);
  }
  if (def.ownerEditable === false) {
    return fail(
      "not_owner_editable",
      `${def.label} is fixed by the factory and cannot be changed.`,
    );
  }
  return validateValue(def, value);
}

/**
 * Full validation for a CLIENT write to `key`: unknown-key rejection, the
 * setting must be client-scoped, then value validation.
 */
export function validateClientWrite(key: string, value: unknown): ValidationResult {
  const def = getDefinition(key);
  if (!def) {
    return fail("unknown_key", `Unknown setting "${key}".`);
  }
  if (def.clientScoped !== true) {
    return fail(
      "not_owner_editable",
      `${def.label} is not a per-client preference.`,
    );
  }
  return validateValue(def, value);
}
