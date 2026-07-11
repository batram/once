const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const rules = require("./webpack.rules")

const root = path.resolve(__dirname, "../..")

module.exports = {
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      }
    ]
  },
  resolve: {
    extensions: [".js", ".ts", ".jsx", ".tsx", ".css"],
    fallback: { path: false }
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: path.join(root, "packages", "ui-web", "public", "static", "css"),
          to: "main_window/css"
        },
        {
          from: path.join(root, "packages", "ui-web", "public", "static", "imgs"),
          to: "main_window/imgs"
        }
      ]
    })
  ],
  devtool: "source-map"
}
