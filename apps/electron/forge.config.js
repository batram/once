const path = require("path")
const { FusesPlugin } = require("@electron-forge/plugin-fuses")
const { WebpackPlugin } = require("@electron-forge/plugin-webpack")
const { FuseVersion, FuseV1Options } = require("@electron/fuses")
const { version } = require("../../package.json")

module.exports = {
  outDir: path.resolve(__dirname, "out"),
  packagerConfig: {
    asar: true,
    appVersion: version,
    buildVersion: version,
    name: "Once",
    executableName: "once",
    icon: path.resolve(
      __dirname,
      "../../packages/ui-web/public/static/imgs/icons/mipmap-mdpi/ic_launcher"
    ),
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "once",
        authors: "Once contributors",
        description: "Collect stories and see them once",
        setupIcon: path.resolve(
          __dirname,
          "../../packages/ui-web/public/static/imgs/icons/mipmap-mdpi/ic_launcher.ico"
        ),
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
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
              js: "./src/preload.ts",
            },
          },
        ],
      },
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
}
