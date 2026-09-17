const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")
const rules = require("./webpack.rules")
const { bundledAddons } = require("../../scripts/bundled-addons")

const root = path.resolve(__dirname, "../..")

module.exports = {
  module: {
    parser: {
      javascript: { url: false }
    },
    rules: [
      ...rules,
      {
        test: /\.css$/,
        resourceQuery: { not: [/raw/] },
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"],
    fallback: { path: false }
  },
  plugins: [
    new webpack.DefinePlugin({
      __ONCE_BUNDLED_ADDONS__: JSON.stringify(bundledAddons())
    }),
    new webpack.IgnorePlugin({ resourceRegExp: /^node:module$/ }),
    new CopyPlugin({
      patterns: [
        {
          from: path.join(root, "packages", "ui-web", "public", "static", "css"),
          to: "main_window/css"
        },
        {
          from: path.join(root, "packages", "ui-web", "public", "static", "imgs"),
          to: "main_window/imgs"
        },
        {
          from: path.join(root, "packages", "ui-web", "src", "reader", "wafli-module.wasm"),
          to: "reader_runtime/wafli-module.wasm"
        },
        {
          from: path.join(root, "packages", "ui-web", "src", "reader", "wafli-licenses"),
          to: "reader_runtime/licenses/wafli"
        }
      ]
    })
  ],
  devtool: "source-map"
}
