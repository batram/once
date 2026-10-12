const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")
const rules = require("./webpack.rules")
const { CacheNamePlugin, esbuildMinimizer, filesystemCache, PrebuiltMinifiedAssetsPlugin } = require("./webpack.shared")
const { bundledAddons } = require("../../scripts/bundled-addons")
const { importMetaUrlDefine } = require("../../scripts/import-meta-url")

const root = path.resolve(__dirname, "../..")

module.exports = {
  module: {
    parser: {
      javascript: { url: false }
    },
    rules: [
      { resourceQuery: /pdf-worker/, type: "asset/resource", generator: { filename: "pdf/pdf.worker.js" } },
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
  cache: filesystemCache(__filename),
  optimization: { minimizer: [esbuildMinimizer()] },
  plugins: [
    new CacheNamePlugin("renderer"),
    new PrebuiltMinifiedAssetsPlugin(/^pdf[\\/]/),
    new webpack.DefinePlugin({
      __ONCE_BUNDLED_ADDONS__: JSON.stringify(bundledAddons()),
      ...importMetaUrlDefine
    }),
    new webpack.IgnorePlugin({ resourceRegExp: /^node:module$/ }),
    new CopyPlugin({
      patterns: [
        { from: path.join(root, "node_modules/pdfjs-dist/LICENSE"), to: "pdf/LICENSE" },
        { from: path.join(root, "node_modules/pdfjs-dist/wasm"), to: "pdf/wasm", globOptions: { ignore: ["**/quickjs*"] } },
        { from: path.join(root, "node_modules/pdfjs-dist/cmaps"), to: "pdf/cmaps" },
        { from: path.join(root, "node_modules/pdfjs-dist/standard_fonts"), to: "pdf/standard_fonts" },
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
