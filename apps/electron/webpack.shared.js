const path = require("path")
const TerserPlugin = require("terser-webpack-plugin")
const { Compilation } = require("webpack")

// Production bundles are minified by esbuild rather than Terser: about three
// times faster for ~2% larger output, which the app loads from disk anyway.
// Everything runs in Electron's own Chromium, so esbuild's default (newest)
// syntax target is safe.
const esbuildMinimizer = () => new TerserPlugin({ minify: TerserPlugin.esbuildMinify })

// Persistent webpack cache shared by the main and renderer configs. Forge
// never closes its compilers, so the cache is written as soon as a compile
// goes idle instead of on close; packaging keeps the process alive meanwhile.
// Unchanged modules and minified bundles then come back from disk.
const cacheDirectory = path.resolve(__dirname, "../../node_modules/.cache/once-electron-webpack")

function filesystemCache(configFile) {
  return {
    type: "filesystem",
    cacheDirectory,
    idleTimeoutForInitialStore: 0,
    buildDependencies: { config: [configFile] }
  }
}

// Names each compiler's cache by bundle, channel and mode so builds that
// differ in any of them never evict each other. Forge builds the renderer
// config twice from one file, once for windows and once for their sandboxed
// preloads, so the name reads the output filename Forge gave that compiler.
class CacheNamePlugin {
  constructor(bundle) {
    this.bundle = bundle
  }

  apply(compiler) {
    const { cache, output, mode } = compiler.options
    if (!cache || cache.type !== "filesystem") return
    const part = this.bundle !== "renderer" ? "" : String(output.filename).includes("preload") ? "-preload" : "-window"
    cache.name = `${this.bundle}${part}-${process.env.ONCE_BUILD_CHANNEL || "release"}-${mode}`
  }
}

// PDF.js ships its worker and no-wasm fallbacks already minified; telling
// the minimizer so skips re-minifying ~2 MB of code.
class PrebuiltMinifiedAssetsPlugin {
  constructor(pattern) {
    this.pattern = pattern
  }

  apply(compiler) {
    compiler.hooks.compilation.tap("PrebuiltMinifiedAssetsPlugin", (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: "PrebuiltMinifiedAssetsPlugin",
          stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY
        },
        (assets) => {
          for (const name of Object.keys(assets)) {
            if (this.pattern.test(name)) compilation.updateAsset(name, (source) => source, { minimized: true })
          }
        }
      )
    })
  }
}

module.exports = { CacheNamePlugin, esbuildMinimizer, filesystemCache, PrebuiltMinifiedAssetsPlugin }
