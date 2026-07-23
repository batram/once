const webpack = require("webpack")
const rules = require("./webpack.rules")
const { devBuildIdentifier } = require("../../scripts/build-identifier")

module.exports = {
  entry: {
    // The main process bundle; package.json "main" resolves to index.js.
    index: "./src/main.ts",
    // Standalone browser-world bundle the main process injects into tabs
    // with executeJavaScript to run the source picker overlay.
    "picker-injection": {
      import: "./src/pickerInjection.ts",
      library: { type: "var", name: "__oncePickerInjectionBundle" }
    }
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
      __ONCE_BUILD_IDENTIFIER__: JSON.stringify(devBuildIdentifier())
    })
  ],
  devtool: "source-map"
}
