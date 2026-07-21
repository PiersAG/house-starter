// Settings errors, in one neutral module so the resolver (read) and the value
// store (write) can both throw them without importing each other (they already
// form a resolver→values dependency; a back-import would be a cycle).

/** Thrown when a key has no definition at all. Unknown keys are never silently null. */
export class UnknownSettingError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Unknown setting "${key}".`);
    this.name = "UnknownSettingError";
    this.key = key;
  }
}

/**
 * Thrown when a key IS defined but belongs to a capability whose flag is off
 * (capability-model-spec R2). It extends UnknownSettingError so any code that
 * already treats an unknown key as "absent" treats a disabled key the same way
 * — an OFF capability's key must look absent at every read/write surface, not
 * merely hidden. Distinct class + message so a developer can tell the two apart.
 */
export class CapabilityDisabledError extends UnknownSettingError {
  constructor(key: string) {
    super(key);
    this.name = "CapabilityDisabledError";
    this.message = `Setting "${key}" belongs to a capability that is turned off.`;
  }
}
