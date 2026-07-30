"use strict"

module.exports = {
  extends: ["stylelint-config-standard"],
  ignoreFiles: [
    "**/dist/**",
    "**/.webpack/**",
    "**/build/**",
    "**/node_modules/**",
    "apps/mobile/android/app/src/main/assets/public/**",
    "apps/mobile/ios/App/App/public/**"
  ],
  rules: {
    "alpha-value-notation": null,
    "color-function-alias-notation": null,
    "color-function-notation": null,
    "comment-empty-line-before": null,
    "custom-property-pattern": null,
    "custom-property-empty-line-before": null,
    "declaration-block-no-duplicate-properties": null,
    "declaration-block-no-redundant-longhand-properties": null,
    "declaration-block-single-line-max-declarations": null,
    "declaration-empty-line-before": null,
    "declaration-property-value-keyword-no-deprecated": null,
    "font-family-name-quotes": null,
    "function-url-quotes": null,
    "import-notation": null,
    "keyframes-name-pattern": null,
    "media-feature-range-notation": null,
    "no-descending-specificity": null,
    "no-duplicate-selectors": null,
    "property-no-deprecated": null,
    "property-no-vendor-prefix": null,
    "rule-empty-line-before": null,
    "selector-class-pattern": null,
    "selector-id-pattern": null,
    "selector-not-notation": null,
    "value-keyword-case": null
  }
}
