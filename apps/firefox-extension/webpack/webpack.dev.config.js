const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")

module.exports = {
  mode: "development",
  entry: {
    background: path.resolve(
      __dirname,
      "..",
      "src",
      "background.ts",
    ),
    sidepanel: path.resolve(
      __dirname,
      "..",
      "src",
      "sidepanel.ts",
    ),
  },
  output: {
    path: path.join(__dirname, "..", "dist"),
    filename: "[name].js",
  },
  devtool: "inline-source-map",
  optimization: {
    minimize: false,
  },
  resolve: {
    extensions: [".ts", ".js"],
    alias: {
      "@once/core": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "core",
        "src",
      ),
      "@once/collectors": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "collectors",
        "src",
      ),
      "@once/app": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "app",
        "src",
      ),
      "@once/ui-web": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "ui-web",
        "src",
      ),
      "@once/persistence": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "persistence",
        "src",
      ),
      "@once/platform-webext": path.resolve(
        __dirname,
        "..",
        "..",
        "..",
        "packages",
        "platform-webext",
        "src",
      ),
    },
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
      patterns: [
        {
          from: ".",
          to: ".",
          context: path.resolve(__dirname, "..", "public"),
        },
      ],
    }),
  ],
}
