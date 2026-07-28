import {
  HOMEPAGE_SECTION_TYPES,
  type HomepageContent,
  type HomepageSectionType,
} from "./types";

/**
 * Runtime validator for content/homepage.json (card 2.3.7).
 *
 * WHY THIS EXISTS: app/page.tsx imports the JSON and casts it to
 * HomepageContent. A cast is a promise, not a check — TypeScript never reads
 * the file's contents, so a malformed or unknown block would sail past `tsc`
 * and fail in front of a customer. This validator is the actual gate, and
 * tests/unit/homepage-content.test.ts runs it against the shipped file so a
 * broken homepage cannot reach main.
 *
 * Deliberately dependency-free: no zod, no ajv. The schema is small, the
 * template pins every dependency exactly, and a landing-page validator is not
 * worth a supply-chain edge.
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkCta(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!nonEmptyString(value.label)) {
    errors.push(`${path}.label must be a non-empty string`);
  }
  if (!nonEmptyString(value.href)) {
    errors.push(`${path}.href must be a non-empty string`);
  } else if (!(value.href as string).startsWith("/")) {
    errors.push(`${path}.href must be a route starting with "/"`);
  }
}

function checkFeatures(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  value.forEach((feature, i) => {
    if (!isRecord(feature)) {
      errors.push(`${path}[${i}] must be an object`);
      return;
    }
    if (!nonEmptyString(feature.title)) {
      errors.push(`${path}[${i}].title must be a non-empty string`);
    }
    if (typeof feature.description !== "string") {
      errors.push(`${path}[${i}].description must be a string`);
    }
  });
}

/** Per-block content checks, keyed by the section's discriminant. */
const BLOCK_CHECKS: Record<
  HomepageSectionType,
  (content: unknown, path: string, errors: string[]) => void
> = {
  hero(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (typeof content.subheading !== "string")
      errors.push(`${path}.subheading must be a string`);
    checkCta(content.cta, `${path}.cta`, errors);
  },

  heroSplit(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (typeof content.subheading !== "string")
      errors.push(`${path}.subheading must be a string`);
    checkCta(content.cta, `${path}.cta`, errors);
    if (content.secondaryCta !== undefined) {
      checkCta(content.secondaryCta, `${path}.secondaryCta`, errors);
    }
    for (const key of ["eyebrow", "trustLine"] as const) {
      if (content[key] !== undefined && typeof content[key] !== "string") {
        errors.push(`${path}.${key} must be a string when present`);
      }
    }
  },

  features(content, path, errors) {
    checkFeatures(content, path, errors);
  },

  testimonials(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (!Array.isArray(content.items))
      return void errors.push(`${path}.items must be an array`);
    content.items.forEach((item, i) => {
      if (!isRecord(item))
        return void errors.push(`${path}.items[${i}] must be an object`);
      // A quote with no attributable name is not social proof, it is a slogan.
      if (!nonEmptyString(item.quote))
        errors.push(`${path}.items[${i}].quote must be a non-empty string`);
      if (!nonEmptyString(item.name))
        errors.push(`${path}.items[${i}].name must be a non-empty string`);
      if (item.role !== undefined && typeof item.role !== "string")
        errors.push(`${path}.items[${i}].role must be a string when present`);
    });
  },

  pricing(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (!Array.isArray(content.plans))
      return void errors.push(`${path}.plans must be an array`);
    content.plans.forEach((plan, i) => {
      const at = `${path}.plans[${i}]`;
      if (!isRecord(plan)) return void errors.push(`${at} must be an object`);
      if (!nonEmptyString(plan.name))
        errors.push(`${at}.name must be a non-empty string`);
      // A price must be a formatted string a human wrote. Never a bare number:
      // a number here would force the renderer to guess a currency.
      if (!nonEmptyString(plan.price))
        errors.push(`${at}.price must be a non-empty formatted string`);
      if (!Array.isArray(plan.features))
        errors.push(`${at}.features must be an array`);
      else
        plan.features.forEach((f, fi) => {
          if (!nonEmptyString(f))
            errors.push(`${at}.features[${fi}] must be a non-empty string`);
        });
      checkCta(plan.cta, `${at}.cta`, errors);
      if (plan.featured !== undefined && typeof plan.featured !== "boolean")
        errors.push(`${at}.featured must be a boolean when present`);
    });
  },

  faq(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (!Array.isArray(content.items))
      return void errors.push(`${path}.items must be an array`);
    content.items.forEach((item, i) => {
      if (!isRecord(item))
        return void errors.push(`${path}.items[${i}] must be an object`);
      if (!nonEmptyString(item.question))
        errors.push(`${path}.items[${i}].question must be a non-empty string`);
      if (!nonEmptyString(item.answer))
        errors.push(`${path}.items[${i}].answer must be a non-empty string`);
    });
  },

  cta(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.heading))
      errors.push(`${path}.heading must be a non-empty string`);
    if (typeof content.subheading !== "string")
      errors.push(`${path}.subheading must be a string`);
    checkCta(content, path, errors);
  },

  footer(content, path, errors) {
    if (!isRecord(content)) return void errors.push(`${path} must be an object`);
    if (!nonEmptyString(content.tagline))
      errors.push(`${path}.tagline must be a non-empty string`);
  },
};

/**
 * Validate a parsed content/homepage.json. Returns every problem found rather
 * than throwing on the first, so a broken file is fixed in one pass.
 */
export function validateHomepage(data: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(data)) {
    return { ok: false, errors: ["homepage.json must be a JSON object"] };
  }

  if (!nonEmptyString(data.product)) {
    errors.push("product must be a non-empty string");
  }

  // The four original sections stay REQUIRED: app/page.tsx falls back to them
  // whenever `sections` is absent, and metadata reads hero.subheading whether
  // or not a composition is present.
  BLOCK_CHECKS.hero(data.hero, "hero", errors);
  checkFeatures(data.features, "features", errors);
  BLOCK_CHECKS.cta(data.cta, "cta", errors);
  BLOCK_CHECKS.footer(data.footer, "footer", errors);

  if (data.sections !== undefined) {
    if (!Array.isArray(data.sections)) {
      errors.push("sections must be an array when present");
    } else if (data.sections.length === 0) {
      // An empty array would render a blank page while looking deliberate.
      errors.push("sections must not be empty when present — omit the key instead");
    } else {
      data.sections.forEach((section, i) => {
        const at = `sections[${i}]`;
        if (!isRecord(section)) {
          errors.push(`${at} must be an object`);
          return;
        }
        const type = section.type;
        if (!nonEmptyString(type)) {
          errors.push(`${at}.type must be a non-empty string`);
          return;
        }
        if (!(HOMEPAGE_SECTION_TYPES as readonly string[]).includes(type)) {
          // THE unknown-block gate: the renderer has no case for this, so it
          // would render nothing and the page would silently lose a section.
          errors.push(
            `${at}.type "${type}" is not a known block — expected one of: ${HOMEPAGE_SECTION_TYPES.join(", ")}`,
          );
          return;
        }
        if (!("content" in section)) {
          errors.push(`${at}.content is required`);
          return;
        }
        BLOCK_CHECKS[type as HomepageSectionType](
          section.content,
          `${at}.content`,
          errors,
        );
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Throwing wrapper for callers that want a hard failure. */
export function assertValidHomepage(data: unknown): HomepageContent {
  const result = validateHomepage(data);
  if (!result.ok) {
    throw new Error(
      `Invalid content/homepage.json:\n  - ${result.errors.join("\n  - ")}`,
    );
  }
  return data as HomepageContent;
}
