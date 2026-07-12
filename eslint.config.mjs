import js from "@eslint/js"
import stylistic from "@stylistic/eslint-plugin"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/*.min.js",
      "web-ext-artifacts/",
      "test-results/",
      "apps/electron/out/",
      "apps/electron/.webpack/"
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommended,
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
