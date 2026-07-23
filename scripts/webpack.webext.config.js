const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")

const root = path.resolve(__dirname, "..")
const { version } = require(path.join(root, "package.json"))
const targets = new Set(["chrome", "firefox"])

module.exports = (env = {}, argv = {}) => {
  const target = env.target
  if (!targets.has(target)) {
    throw new Error(`Pass --env target=chrome or --env target=firefox (received ${target || "none"})`)
  }

  const mode = argv.mode || "development"
  const buildChannel = mode === "production" ? "release" : "dev"
  const appRoot = path.join(root, "apps", `${target}-extension`)

  return {
    mode,
    entry: {
      background: path.join(appRoot, "src", "background.ts"),
      sidepanel: path.join(root, "packages", "webext-shell", "dist", "sidepanel.js"),
      "reader-content": path.join(root, "packages", "ui-web", "dist", "reader", "contentScript.js"),
      "picker-content": path.join(root, "packages", "ui-web", "dist", "picker", "contentScript.js")
    },
    output: {
      path: path.join(appRoot, "dist", buildChannel),
      filename: "[name].js",
      clean: true,
      globalObject: "globalThis",
      environment: {
        globalThis: true
      }
    },
    devtool: mode === "development" ? "inline-source-map" : false,
    optimization: {
      minimize: mode === "production",
      splitChunks: {
        cacheGroups: {
          pouchdb: {
            test: /[\\/]node_modules[\\/]pouchdb-browser[\\/]/,
            name: "vendor-pouchdb",
            chunks: (chunk) => chunk.name === "sidepanel",
            enforce: true
          },
          readability: {
            test: /[\\/]node_modules[\\/]@mozilla[\\/]readability[\\/]/,
            name: "vendor-readability",
            chunks: (chunk) => chunk.name === "sidepanel",
            enforce: true
          }
        }
      }
    },
    performance: {
      maxAssetSize: 350 * 1024,
      maxEntrypointSize: 350 * 1024
    },
    resolve: {
      extensions: [".ts", ".js"],
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
          options: {
            configFile: path.join(root, "tsconfig.json")
          }
        }
      ]
    },
    plugins: [
      new webpack.DefinePlugin({
        __ONCE_WEBEXT_TARGET__: JSON.stringify(target),
        __ONCE_BUILD_CHANNEL__: JSON.stringify(buildChannel)
      }),
      new CopyPlugin({
        patterns: [
          {
            from: path.join(root, "packages", "ui-web", "public", "static"),
            to: "static",
            globOptions: {
              ignore: ["**/*.ico"]
            }
          },
          {
            from: path.join(root, "packages", "ui-web", "src", "reader", "readerDocument.css"),
            to: "reader.css"
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "shell.html"),
            to: "static/sidepanel.html",
            transform(content) {
              return content
                .toString()
                .replace(
                  "</body>",
                  [
                    '  <script src="../vendor-pouchdb.js"></script>',
                    '  <script src="../vendor-readability.js"></script>',
                    '  <script src="../sidepanel.js"></script>',
                    "  </body>"
                  ].join("\n")
                )
            }
          },
          {
            from: path.join(appRoot, "public", "manifest.json"),
            to: "manifest.json",
            transform(content) {
              const manifest = JSON.parse(content.toString())
              manifest.version = version
              if (buildChannel === "dev") {
                manifest.name = `${manifest.name} (dev)`
              }
              let json = JSON.stringify(manifest, null, 2)
              if (buildChannel === "dev") {
                json = json.replaceAll("ic_launcher.png", "ic_launcher_dev.png")
              }
              return `${json}\n`
            }
          }
        ]
      })
    ]
  }
}
