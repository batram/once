const { spawnSync } = require("child_process")
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
const linuxWindowIcon = path.resolve(
  __dirname,
  "../../packages/ui-web/public/static/imgs/icons",
  isDevChannel ? "icon_dev.png" : "icon.png"
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
    // Packager appends the platform's icon extension itself (.ico, .icns).
    icon: iconBase,
    appBundleId: isDevChannel ? "app.once.desktop.dev" : "app.once.desktop",
    appCategoryType: "public.app-category.news",
    // Runtime-owned files travel beside the asar. Linux reads the PNG directly
    // because its executable does not contain a Windows-style icon resource.
    extraResource: [
      path.resolve(__dirname, "../../vendor/extensions"),
      linuxWindowIcon
    ]
  },
  hooks: {
    // Packaging rewrites Info.plist and the resources, which invalidates the
    // ad-hoc signature Electron ships with. Re-sign ad-hoc so the bundle
    // verifies again and safeStorage gets a stable Keychain identity; a real
    // Developer ID signature is a separate, later step.
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== "darwin") return
      for (const outputPath of outputPaths) {
        const appBundle = path.join(outputPath, `${module.exports.packagerConfig.name}.app`)
        const result = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appBundle], {
          stdio: "inherit"
        })
        if (result.status !== 0) {
          throw new Error(`Ad-hoc codesign failed for ${appBundle}`)
        }
      }
    }
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
      platforms: ["win32", "linux", "darwin"]
    },
    {
      // Unsigned: without an Apple Developer certificate the first launch
      // needs the Gatekeeper override described in docs/RELEASING.md.
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        icon: `${iconBase}.icns`,
        format: "ULFO"
      }
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: isDevChannel ? "once-dev" : "once",
          productName: isDevChannel ? "Once Dev" : "Once",
          genericName: "Feed Reader",
          bin: isDevChannel ? "once-dev" : "once",
          maintainer: "Once contributors",
          icon: linuxWindowIcon,
          categories: ["Utility"]
        }
      }
    }
  ],
  plugins: [
    new WebpackPlugin({
      mainConfig: "./webpack.main.config.js",
      renderer: {
        config: "./webpack.renderer.config.js",
        entryPoints: [
          {
            html: "./src/extensions/extension-menu.html",
            js: "./src/extensions/extensionMenuRenderer.ts",
            name: "extension_menu",
            preload: { js: "./src/extensions/extensionMenuPreload.ts" }
          },
          {
            html: "../../packages/ui-web/public/shell.html",
            js: "./src/renderer.ts",
            name: "main_window",
            preload: {
              js: "./src/preload.ts"
            }
          },
          // Compiled as its own browser bundle and served by once-reader://.
          // Reader pages execute this bundle directly; never serialize its
          // functions from the minified shell bundle with Function#toString.
          {
            html: "./src/reader-runtime.html",
            js: "./src/readerRuntime.ts",
            name: "reader_runtime"
          },
          // The add-on sandbox page: loaded by the renderer in a sandboxed
          // iframe, with no preload and therefore no bridge of any kind.
          {
            html: "../../packages/ui-web/public/addon-sandbox.html",
            js: "./src/addonSandbox.ts",
            name: "addon_sandbox"
          },
          // A tray's conversation in a browser tab: served under once-addon://
          // like the sandbox, with a preload that only relays to the shell.
          {
            html: "../../packages/ui-web/public/addon-conversation.html",
            js: "./src/addonConversation.ts",
            name: "addon_conversation",
            preload: { js: "./src/addonConversationPreload.ts" }
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
