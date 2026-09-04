const crypto = require("crypto")
const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")
const { devBuildIdentifier } = require("./build-identifier")

const root = path.resolve(__dirname, "..")
const { version } = require(path.join(root, "package.json"))
const targets = new Set(["chrome", "firefox"])

// A self-contained sandbox page with the runtime inlined and allowed by hash,
// for hosting on an origin of the user's choosing: Firefox implements no
// manifest `sandbox` and forbids blob: scripts on extension pages, so its
// scripted add-ons run in a frame pointed at a hosted copy of this file.
class AddonSandboxHostedPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("AddonSandboxHosted", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "AddonSandboxHosted",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
        },
        (assets) => {
          const runtime = assets["addon-sandbox.js"]
          const page = assets["static/addon-sandbox.html"]
          if (!runtime || !page) {
            throw new Error("AddonSandboxHosted expects addon-sandbox.js and static/addon-sandbox.html assets")
          }
          const inlined = runtime.source().toString().replace(/<\/script/gi, "<\\/script")
          const hash = crypto.createHash("sha256").update(inlined, "utf8").digest("base64")
          const html = page.source().toString()
            .replace("script-src 'self' blob:", `script-src 'sha256-${hash}' blob:`)
            .replace('  <script src="../addon-sandbox.js"></script>\n', "")
            .replace("</body>", `  <script>${inlined}</script>\n  </body>`)
          compilation.emitAsset("static/addon-sandbox-hosted.html", new compiler.webpack.sources.RawSource(html))
        }
      )
    })
  }
}

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
      "addon-sandbox": path.join(root, "packages", "webext-shell", "dist", "addonSandbox.js"),
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
        __ONCE_BUILD_CHANNEL__: JSON.stringify(buildChannel),
        __ONCE_BUILD_IDENTIFIER__: JSON.stringify(devBuildIdentifier())
      }),
      new AddonSandboxHostedPlugin(),
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
            from: path.join(root, "packages", "webext-shell", "src", "webext.css"),
            to: "static/css/webext.css"
          },
          // The add-on sandbox page. Chrome loads it as a manifest `sandbox`
          // page with the runtime as a sibling script; AddonSandboxHostedPlugin
          // below also emits a self-contained copy for hosting elsewhere,
          // which is what Firefox needs.
          {
            from: path.join(root, "packages", "ui-web", "public", "addon-sandbox.html"),
            to: "static/addon-sandbox.html",
            transform(content) {
              return content.toString().replace("</body>", '  <script src="../addon-sandbox.js"></script>\n  </body>')
            }
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "shell.html"),
            to: "static/sidepanel.html",
            transform(content) {
              return content
                .toString()
                .replace(
                  '<link rel="stylesheet" href="css/style.css" />',
                  [
                    '<link rel="stylesheet" href="css/style.css" />',
                    '    <link rel="stylesheet" href="css/webext.css" />'
                  ].join("\n")
                )
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
