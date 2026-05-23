import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

const existingCodeCompatibilityRules = {
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/no-deprecated": "off",
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-floating-promises": "off",
  "@typescript-eslint/no-implied-eval": "off",
  "@typescript-eslint/no-misused-promises": "off",
  "@typescript-eslint/no-unnecessary-type-assertion": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/no-unsafe-return": "off",
  "@typescript-eslint/no-unused-vars": "off",
  "import/no-nodejs-modules": "off",
  "no-undef": "off",
  "obsidianmd/hardcoded-config-path": "off",
  "obsidianmd/no-global-this": "off",
  "obsidianmd/no-static-styles-assignment": "off",
  "obsidianmd/no-unsupported-api": "off",
  "obsidianmd/prefer-active-doc": "off",
  "obsidianmd/prefer-file-manager-trash-file": "off",
  "obsidianmd/rule-custom-message": "off",
  "obsidianmd/settings-tab/no-manual-html-headings": "off",
  "obsidianmd/ui/sentence-case": "off",
};

export default tseslint.config(
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: existingCodeCompatibilityRules,
  },
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      "import/no-nodejs-modules": "off",
    },
  },
  {
    files: ["*.js", "*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "import/no-nodejs-modules": "off",
      "import/no-extraneous-dependencies": "off",
    },
  },
  globalIgnores([
    "node_modules",
    "dist",
    "coverage",
    "eslint.config.mjs",
    "esbuild.config.mjs",
    "jest.config.js",
    "main.js",
    "manifest.json",
    "package.json",
    "package-lock.json",
    "versions.json",
  ]),
);
