import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      ".claude/",
      "**/*.min.js",
      "web-ext-artifacts/",
      "test-results/",
      "playwright-report/",
      // gitignored scratch: run artifacts and e2e profiles, which carry copies
      // of whole third-party extensions. Flat config does not read .gitignore.
      "artifacts/",
      // design references dropped in as-is; not repo source
      "docs/**/*.js",
      "docs/**/*.jsx",
      "apps/electron/out/",
      "apps/electron/.webpack/",
      "apps/mobile/android/**/build/",
      "apps/mobile/android/app/src/main/assets/",
      // third-party extension bundles unpacked by scripts/fetch-extensions.js
      "vendor/extensions/",
      "apps/mobile/ios/build/",
      "apps/mobile/ios/App/App/public/"
    ]
  },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.commonjs,
        ...globals.es2021
      }
    },
    plugins: {
      "@stylistic": stylistic
    },
    rules: {
      "@stylistic/indent": ["error", 2, { SwitchCase: 1 }],
      "@stylistic/linebreak-style": ["error", "unix"],
      "@stylistic/quotes": ["error", "double", { avoidEscape: true }],
      "@stylistic/semi": ["error", "never"],
      "@stylistic/comma-dangle": ["warn", "never"],
      "prefer-const": "warn",
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-require-imports": [
        "error",
        { allowAsImport: true }
      ],
      "@typescript-eslint/no-extraneous-class": [
        "error",
        { allowStaticOnly: true }
      ]
    }
  },
  {
    files: ["**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  },
  {
    files: ["tests/**"],
    rules: {
      "@typescript-eslint/no-empty-function": "off"
    }
  }
)
