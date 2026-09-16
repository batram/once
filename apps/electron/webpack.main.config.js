const fs = require("fs")
const path = require("path")
const webpack = require("webpack")
const rules = require("./webpack.rules")
const { devBuildIdentifier } = require("../../scripts/build-identifier")

// The app icon, inlined for the tab preload's "Add to Once" badge on the
// Add-ons site; a data URL keeps the sandboxed preload free of file access.
const appIconSvg = fs.readFileSync(
  path.resolve(__dirname, "../../packages/ui-web/public/static/imgs/icons/icon.svg"),
  "utf8"
)

module.exports = {
  entry: {
    // The main process bundle; package.json "main" resolves to index.js.
    index: "./src/main.ts",
    // Standalone browser-world bundle the main process injects into tabs
    // with executeJavaScript to run the source picker overlay.
    "picker-injection": {
      import: "./src/pickerInjection.ts",
      library: { type: "var", name: "__oncePickerInjectionBundle" }
    },
    // Sandboxed preload for extension pages (background, popup, options);
    // it builds the `browser` object those pages call.
    "extension-preload": "./src/extensions/extensionPreload.ts",
    // Frame preload for browser tabs; runs extension content scripts in
    // isolated worlds and exposes nothing to the page's own world.
    "content-preload": "./src/extensions/contentPreload.ts"
  },
  output: {
    filename: "[name].js"
  },
  module: {
    rules: [
      ...rules,
      {
        test: /error-page\.css$/,
        type: "asset/source"
      }
    ]
  },
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"]
  },
  plugins: [
    new webpack.DefinePlugin({
      __ONCE_BUILD_CHANNEL__: JSON.stringify(
        process.env.ONCE_BUILD_CHANNEL === "dev" ? "dev" : "release"
      ),
      __ONCE_BUILD_IDENTIFIER__: JSON.stringify(devBuildIdentifier()),
      __ONCE_APP_ICON_SVG__: JSON.stringify(appIconSvg)
    })
  ],
  devtool: "source-map"
}
