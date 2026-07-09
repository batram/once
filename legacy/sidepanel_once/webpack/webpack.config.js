const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
module.exports = {
  mode: "production",
  entry: {
    background: path.resolve(__dirname, "..", "src", "background.ts"),
    sidepanel: path.resolve(
      __dirname,
      "..",
      "src",
      "js",
      "view",
      "sidepanel.ts"
    ),
  },
  output: {
    path: path.join(__dirname, "../dist"),
    filename: "[name].js",
  },
  //devtool: "inline-source-map",
  resolve: {
    extensions: [".ts", ".js"],
    fallback: { path: false },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [{ from: ".", to: ".", context: "public" }],
    }),
  ],
}
