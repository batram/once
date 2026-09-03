const path = require("path")
const { FusesPlugin } = require("@electron-forge/plugin-fuses")
const { WebpackPlugin } = require("@electron-forge/plugin-webpack")
const { FuseVersion, FuseV1Options } = require("@electron/fuses")
const { version } = require("../../package.json")

// Dev bundles ("--dev" via run-forge.js) get their own name, executable and
// icon so they are distinguishable and installable next to a release build.
const isDevChannel = process.env.ONCE_BUILD_CHANNEL === "dev"
const iconBase = path.resolve(
  __dirname,
  "../../packages/ui-web/public/static/imgs/icons/mipmap-mdpi",
  isDevChannel ? "ic_launcher_dev" : "ic_launcher"
)

module.exports = {
  // Dev bundles get their own output tree so Squirrel's make outputs (notably
  // the shared RELEASES metadata file) never mix with release artifacts.
  outDir: path.resolve(__dirname, isDevChannel ? "out/dev" : "out"),
  packagerConfig: {
    asar: true,
    appVersion: version,
    buildVersion: version,
    name: isDevChannel ? "Once Dev" : "Once",
    executableName: isDevChannel ? "once-dev" : "once",
    icon: iconBase,
    // The vendored extension bundles (scripts/fetch-extensions.js) travel
    // beside the asar as resources/extensions, where the runtime reads them.
    extraResource: [path.resolve(__dirname, "../../vendor/extensions")]
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: isDevChannel ? "oncedev" : "once",
        authors: "Once contributors",
        description: "Collect stories and see them once",
        setupIcon: `${iconBase}.ico`
      }
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"]
    }
  ],
  plugins: [
    new WebpackPlugin({
      mainConfig: "./webpack.main.config.js",
      renderer: {
        config: "./webpack.renderer.config.js",
        entryPoints: [
          {
            html: "../../packages/ui-web/public/shell.html",
            js: "./src/renderer.ts",
            name: "main_window",
            preload: {
              js: "./src/preload.ts"
            }
          }
        ]
      }
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
}
