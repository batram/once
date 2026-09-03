const crypto = require("crypto")
const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")
const { devBuildIdentifier } = require("../../scripts/build-identifier")

const root = path.resolve(__dirname, "../..")
const { version } = require(path.join(root, "package.json"))

// The reader runtime is inlined into the sandboxed reader frame because older
// WebKit (iOS <= 18) refuses to load external scripts there. The frame
// inherits the app CSP, so script-src carries the sha256 of the exact inline
// text: only that script can ever run inline. The escaping applied here must
// stay identical to ReaderDocumentHost.injectRuntime's.
class ReaderRuntimeCspPlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("ReaderRuntimeCsp", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "ReaderRuntimeCsp",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
        },
        (assets) => {
          const runtime = assets["reader-runtime.js"]
          const index = assets["index.html"]
          if (!runtime || !index) {
            throw new Error("ReaderRuntimeCsp expects reader-runtime.js and index.html assets")
          }
          const inlined = runtime.source().toString().replace(/<\/script/gi, "<\\/script")
          const hash = crypto.createHash("sha256").update(inlined, "utf8").digest("base64")
          const html = index.source().toString().replace(
            "script-src 'self'",
            `script-src 'self' 'sha256-${hash}'`
          )
          compilation.updateAsset("index.html", new compiler.webpack.sources.RawSource(html))
        }
      )
    })
  }
}

// The add-on sandbox runtime is inlined into its page for the same reason the
// reader runtime is: older WebKit refuses external scripts inside an
// opaque-origin sandboxed frame. The page's own policy then allows exactly
// that inline text by hash, plus blob: for the add-on's code.
class AddonSandboxInlinePlugin {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("AddonSandboxInline", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "AddonSandboxInline",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
        },
        (assets) => {
          const runtime = assets["addon-sandbox.js"]
          const page = assets["addon-sandbox.html"]
          if (!runtime || !page) {
            throw new Error("AddonSandboxInline expects addon-sandbox.js and addon-sandbox.html assets")
          }
          const inlined = runtime.source().toString().replace(/<\/script/gi, "<\\/script")
          const hash = crypto.createHash("sha256").update(inlined, "utf8").digest("base64")
          const html = page.source().toString()
            .replace("script-src 'self' blob:", `script-src 'sha256-${hash}' blob:`)
            .replace("</body>", `  <script>${inlined}</script>\n  </body>`)
          compilation.updateAsset("addon-sandbox.html", new compiler.webpack.sources.RawSource(html))
        }
      )
    })
  }
}

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
      "reader-runtime": path.join(__dirname, "src", "readerRuntime.ts"),
      "picker-injection": path.join(__dirname, "src", "pickerInjection.ts"),
      "addon-sandbox": path.join(__dirname, "src", "addonSandbox.ts")
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
        __ONCE_BUILD_IDENTIFIER__: JSON.stringify(devBuildIdentifier()),
        __ONCE_MOBILE_E2E__: JSON.stringify(process.env.ONCE_MOBILE_E2E === "1")
      }),
      new ReaderRuntimeCspPlugin(),
      new AddonSandboxInlinePlugin(),
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
            from: path.join(__dirname, "src", "mobile.css"),
            to: "mobile.css"
          },
          // The add-on sandbox page, a navigated document rather than a
          // srcdoc frame, so it carries its own policy instead of the app's.
          // AddonSandboxInlinePlugin inlines the runtime into it below.
          {
            from: path.join(root, "packages", "ui-web", "public", "addon-sandbox.html"),
            to: "addon-sandbox.html"
          },
          {
            from: path.join(root, "packages", "ui-web", "public", "shell.html"),
            to: "index.html",
            transform(content) {
              return content
                .toString()
                .replace("<title>once</title>", `<title>${channel === "dev" ? "Once Dev" : "Once"}</title>`)
                .replace(
                  '<link rel="stylesheet" href="css/style.css" />',
                  '<link rel="stylesheet" href="css/style.css" />\n    <link rel="stylesheet" href="mobile.css" />'
                )
                .replace(
                  '<meta charset="UTF-8" />',
                  '<meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />'
                )
                .replace(
                  '<body animated="true">',
                  '<body animated="true" data-platform="mobile">'
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
