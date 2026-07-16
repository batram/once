const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")

const root = path.resolve(__dirname, "../..")
const { version } = require(path.join(root, "package.json"))

module.exports = (_env = {}, argv = {}) => {
  const mode = argv.mode || "development"
  const channel = process.env.ONCE_BUILD_CHANNEL || "dev"
  if (channel !== "dev" && channel !== "release") {
    throw new Error(`ONCE_BUILD_CHANNEL must be dev or release (received ${channel})`)
  }

  return {
    mode,
    entry: {
      mobile: path.join(__dirname, "src", "main.ts"),
      "reader-runtime": path.join(__dirname, "src", "readerRuntime.ts")
    },
    output: {
      path: path.join(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
      globalObject: "globalThis"
    },
    devtool: mode === "development" ? "inline-source-map" : false,
    resolve: {
      extensions: [".ts", ".js", ".css"],
      fallback: { path: false }
    },
    module: {
      rules: [
        {
          resourceQuery: /raw/,
          type: "asset/source"
        },
        {
          test: /\.tsx?$/,
          loader: "ts-loader",
          exclude: /node_modules/,
          options: { configFile: path.join(__dirname, "tsconfig.json") }
        },
        {
          test: /\.css$/,
          resourceQuery: { not: [/raw/] },
          use: ["style-loader", "css-loader"]
        }
      ]
    },
    plugins: [
      new webpack.DefinePlugin({
        __ONCE_APP_VERSION__: JSON.stringify(version),
        __ONCE_BUILD_CHANNEL__: JSON.stringify(channel),
        __ONCE_MOBILE_E2E__: JSON.stringify(process.env.ONCE_MOBILE_E2E === "1")
      }),
      new CopyPlugin({
        patterns: [
          {
            from: path.join(root, "packages", "ui-web", "public", "static", "css"),
            to: "css"
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "static", "imgs"),
            to: "imgs"
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "shell.html"),
            to: "index.html",
            transform(content) {
              return content
                .toString()
                .replace("<title>once</title>", `<title>${channel === "dev" ? "Once Dev" : "Once"}</title>`)
                .replace(
                  '<meta charset="UTF-8" />',
                  '<meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />'
                )
                .replace("</body>", '  <script src="mobile.js"></script>\n  </body>')
            }
          }
        ]
      })
    ],
    devServer: {
      host: "0.0.0.0",
      port: 5173,
      hot: true,
      devMiddleware: { writeToDisk: true },
      static: { directory: path.join(__dirname, "dist") }
    }
  }
}
