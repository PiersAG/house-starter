import { FlatCompat } from "@eslint/eslintrc";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  // Generated code stays maintainable (app-business-core issue 512; Matt Murphy
  // #22). Measured on the clean template on 2026-11-01: the largest file has
  // well under 400 lines of code and the longest function under 200, and every
  // name already follows the convention — so these block from the start. A file
  // or function over the limit is split into coherent modules with clear
  // ownership and interfaces (skills/build/quality-baseline in the factory),
  // never excused.
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "config/**/*.ts"],
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      // Naming conventions: camelCase values and functions, PascalCase types and
      // components, UPPER_CASE constants; object keys are left free (they mirror
      // HTTP headers, database columns and outside APIs).
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["camelCase"], leadingUnderscore: "allow" },
        { selector: "variable", format: ["camelCase", "UPPER_CASE", "PascalCase"], leadingUnderscore: "allow" },
        { selector: "function", format: ["camelCase", "PascalCase"], leadingUnderscore: "allowDouble" },
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "enumMember", format: ["PascalCase", "UPPER_CASE"] },
        { selector: "parameter", format: ["camelCase", "PascalCase"], leadingUnderscore: "allow" },
        {
          selector: ["objectLiteralProperty", "typeProperty", "objectLiteralMethod", "classProperty", "import"],
          format: null,
        },
      ],
    },
  },
];

export default eslintConfig;
