const crypto = require("crypto")
const path = require("path")
const CopyPlugin = require("copy-webpack-plugin")
const webpack = require("webpack")
const { devBuildIdentifier } = require("../../scripts/build-identifier")
const { bundledAddons } = require("../../scripts/bundled-addons")
const { importMetaUrlDefine } = require("../../scripts/import-meta-url")

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

// The add-on and PDF sandbox runtimes are inlined into their pages for the
// same reason the reader runtime is: older WebKit refuses external scripts
// inside an opaque-origin sandboxed frame. Each page's own policy then allows
// exactly that inline text by hash, plus blob: for what it loads itself.
class SandboxInlinePlugin {
  constructor(name) {
    this.name = name
  }

  apply(compiler) {
    const script = `${this.name}.js`
    const page = `${this.name}.html`
    compiler.hooks.thisCompilation.tap("SandboxInline", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "SandboxInline",
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE
        },
        (assets) => {
          const runtime = assets[script]
          const html = assets[page]
          if (!runtime || !html) {
            throw new Error(`SandboxInline expects ${script} and ${page} assets`)
          }
          const inlined = runtime.source().toString().replace(/<\/script/gi, "<\\/script")
          const hash = crypto.createHash("sha256").update(inlined, "utf8").digest("base64")
          const source = html.source().toString()
          // Replacer functions: a bundle contains `$$` and `$&`, which a
          // replacement string would rewrite and so break the hash.
          const output = source
            .replace("script-src 'self' blob:", () => `script-src 'sha256-${hash}' blob:`)
            .replace("</body>", () => `  <script>${inlined}</script>\n  </body>`)
          if (output === source) throw new Error(`${page} no longer carries the expected script-src policy`)
          compilation.updateAsset(page, new compiler.webpack.sources.RawSource(output))
        }
      )
    })
  }
}

/** The shell bundle and the scripts it injects into pages and frames. */
const entry = {
  mobile: path.join(__dirname, "src", "main.ts"),
  "reader-runtime": path.join(__dirname, "src", "readerRuntime.ts"),
  "picker-injection": path.join(__dirname, "src", "pickerInjection.ts"),
  "image-text-injection": path.join(__dirname, "src", "imageTextInjection.ts"),
  // Android's out-of-page image text: the probe evaluated in the page's
  // bridge content script, and the overlay view's own page.
  "image-text-probe": path.join(__dirname, "src", "imageTextProbe.ts"),
  "image-text-overlay": path.join(__dirname, "src", "imageTextOverlayView.ts"),
  "page-find": path.join(__dirname, "src", "pageFindRuntime.ts"),
  "addon-sandbox": path.join(__dirname, "src", "addonSandbox.ts"),
  "pdf-sandbox": path.join(__dirname, "src", "pdfSandbox.ts")
}

module.exports = (_env = {}, argv = {}) => {
  const mode = argv.mode || "development"
  const channel = process.env.ONCE_BUILD_CHANNEL || "dev"
  if (channel !== "dev" && channel !== "release") {
    throw new Error(`ONCE_BUILD_CHANNEL must be dev or release (received ${channel})`)
  }

  return {
    mode,
    entry,
    output: {
      path: path.join(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
      globalObject: "globalThis"
    },
    devtool: mode === "development" ? "inline-source-map" : false,
    resolve: {
      extensions: [".ts", ".js", ".css"],
      fallback: { path: false, stream: require.resolve("stream-browserify"), util: require.resolve("util/"), events: require.resolve("events/"), assert: require.resolve("assert/") }
    },
    module: {
      parser: { javascript: { url: false } },
      rules: [
        { resourceQuery: /pdf-worker/, type: "asset/resource", generator: { filename: "pdf/pdf.worker.js" } },
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
      new webpack.ProvidePlugin({ Buffer: ["buffer", "Buffer"], process: "process/browser.js" }),
      new webpack.DefinePlugin({
        __ONCE_APP_VERSION__: JSON.stringify(version),
        __ONCE_BUILD_CHANNEL__: JSON.stringify(channel),
        __ONCE_BUILD_IDENTIFIER__: JSON.stringify(devBuildIdentifier()),
        __ONCE_MOBILE_E2E__: JSON.stringify(process.env.ONCE_MOBILE_E2E === "1"),
        __ONCE_BUNDLED_ADDONS__: JSON.stringify(bundledAddons()),
        ...importMetaUrlDefine
      }),
      new webpack.IgnorePlugin({ resourceRegExp: /^node:module$/ }),
      new ReaderRuntimeCspPlugin(),
      new SandboxInlinePlugin("addon-sandbox"),
      new SandboxInlinePlugin("pdf-sandbox"),
      new CopyPlugin({
        patterns: [
          { from: path.join(root, "node_modules/pdfjs-dist/LICENSE"), to: "pdf/LICENSE" },
          { from: path.join(root, "node_modules/pdfjs-dist/wasm"), to: "pdf/wasm", filter: (file) => !path.basename(file).startsWith("quickjs") },
          { from: path.join(root, "node_modules/pdfjs-dist/cmaps"), to: "pdf/cmaps" },
          { from: path.join(root, "node_modules/pdfjs-dist/standard_fonts"), to: "pdf/standard_fonts" },
          ...(process.env.ONCE_MOBILE_PLATFORM === "ios" ? [
            // Preserve upstream extension runtime assets, including modules with top-level await.
            { from: path.join(root, "vendor", "extensions", "ublock-origin-lite"), to: "extensions/ublock-origin-lite", globOptions: { dot: false }, info: { minimized: true } },
            { from: path.join(root, "vendor", "extensions", "ios"), to: "extensions", globOptions: { dot: false }, info: { minimized: true } }
          ] : []),
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
          {
            from: path.join(root, "packages", "ui-web", "src", "reader", "wafli-module.wasm"),
            to: "wafli-module.wasm"
          },
          {
            from: path.join(root, "packages", "ui-web", "src", "reader", "wafli-licenses"),
            to: "licenses/wafli"
          },
          // The add-on sandbox page, a navigated document rather than a
          // srcdoc frame, so it carries its own policy instead of the app's.
          // AddonSandboxInlinePlugin inlines the runtime into it below.
          {
            from: path.join(root, "packages", "ui-web", "public", "addon-sandbox.html"),
            to: "addon-sandbox.html"
          },
          // The PDF sandbox page, likewise its own document with its own policy.
          {
            from: path.join(root, "packages", "ui-web", "public", "pdf-sandbox.html"),
            to: "pdf-sandbox.html"
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
