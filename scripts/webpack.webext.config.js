const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")

const root = path.resolve(__dirname, "..")
const targets = new Set(["chrome", "firefox"])

module.exports = (env = {}, argv = {}) => {
  const target = env.target
  if (!targets.has(target)) {
    throw new Error(`Pass --env target=chrome or --env target=firefox (received ${target || "none"})`)
  }

  const mode = argv.mode || "development"
  const appRoot = path.join(root, "apps", `${target}-extension`)

  return {
    mode,
    entry: {
      background: path.join(appRoot, "src", "background.ts"),
      sidepanel: path.join(root, "packages", "webext-shell", "dist", "sidepanel.js"),
      "reader-content": path.join(root, "packages", "ui-web", "dist", "reader", "contentScript.js"),
    },
    output: {
      path: path.join(appRoot, "dist"),
      filename: "[name].js",
      clean: true,
      globalObject: "globalThis",
      environment: {
        globalThis: true,
      },
    },
    devtool: mode === "development" ? "inline-source-map" : false,
    optimization: {
      minimize: mode === "production",
    },
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
          options: {
            configFile: path.join(root, "tsconfig.json"),
          },
        },
      ],
    },
    plugins: [
      new webpack.DefinePlugin({
        __ONCE_WEBEXT_TARGET__: JSON.stringify(target),
      }),
      new CopyPlugin({
        patterns: [
          {
            from: path.join(root, "packages", "ui-web", "public", "static"),
            to: "static",
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "shell.html"),
            to: "static/sidepanel.html",
            transform(content) {
              return content
                .toString()
                .replace("</body>", '  <script src="../sidepanel.js"></script>\n  </body>')
            },
          },
          {
            from: path.join(appRoot, "public", "manifest.json"),
            to: "manifest.json",
          },
        ],
      }),
    ],
  }
}
