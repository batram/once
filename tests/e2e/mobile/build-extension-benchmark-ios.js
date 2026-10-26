// Creates a separate app/project; production sources and user app data stay intact.
const fs = require("node:fs")
const path = require("node:path")
const { fixture } = require("./extension-benchmark-fixture")
const root = path.resolve(__dirname, "../../..")
const out = path.resolve(process.argv[2] || "/tmp/once-extension-benchmark-ios")
fs.mkdirSync(path.join(out, "Bench.xcodeproj"), { recursive: true })
fs.writeFileSync(path.join(out, "Bench.swift"), ["extension-benchmark.swift", "extension-benchmark-support.swift", "ios-filter-regression.swift"].map(name => fs.readFileSync(path.join(__dirname, name), "utf8")).join("\n"))
// The host and the installer sources it depends on (the UIKit prompts stay out).
const hostSources = ["WebExtensionHost.swift", "WebExtensionManagement.swift", "WebExtensionInstaller.swift", "ExtensionArchive.swift"]
for (const name of hostSources) fs.copyFileSync(path.join(root, "apps/mobile/ios/App/App", name), path.join(out, name))
// Only replace Capacitor's dictionary type; exporter/shim implementations are verbatim.
fs.writeFileSync(path.join(out, "ExtensionSupport.swift"), fs.readFileSync(path.join(root, "apps/mobile/ios/App/App/ExtensionSupport.swift"), "utf8").replace("import Capacitor", "typealias JSObject = [String: Any]"))
fs.writeFileSync(path.join(out, "fixture.html"), fixture())
// Minimal DNR packages separate WebKit's rule loading from uBO's background code.
for (const count of [0, 1000, 10000, 50000]) {
  const directory = path.join(out, "public/benchmark-dnr", `dnr${count}`)
  fs.mkdirSync(directory, { recursive: true })
  const manifest = { manifest_version: 3, name: `DNR ${count}`, description: "Deterministic native rule benchmark", version: "1.0",
    permissions: ["declarativeNetRequest"], host_permissions: ["<all_urls>"],
    ...(count ? { declarative_net_request: { rule_resources: [{ id: "rules", enabled: true, path: "rules.json" }] } } : {}) }
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest))
  fs.writeFileSync(path.join(directory, "rules.json"), JSON.stringify(Array.from({ length: count }, (_, index) => ({
    id: index + 1, priority: 1, action: { type: "block" }, condition: { urlFilter: index === 0 ? "/benchmark-blocked" : `||never-match-${index}.example^` }
  }))))
}
for (const name of ["ublock-origin-lite", "darkreader", "sponsorblock", "violentmonkey"]) {
  const source = path.join(root, "vendor/extensions", name === "ublock-origin-lite" ? name : `ios/${name}`)
  fs.cpSync(source, path.join(out, "public/extensions", name), { recursive: true })
}
// Optional pre-downloaded XPIs. Record exact archive hashes in the native result.
if (process.env.ONCE_BENCH_XPI_DIR) {
  const slugs = (process.env.ONCE_BENCH_XPI_SLUGS || "consent-o-matic,clearurls,bitwarden-password-manager,localcdn-fork-of-decentraleyes").split(",")
  const destination = path.join(out, "public/benchmark-packages")
  fs.mkdirSync(destination, { recursive: true })
  for (const slug of slugs) {
    const directory = path.resolve(process.env.ONCE_BENCH_XPI_DIR, slug)
    const files = fs.readdirSync(directory).filter(name => name.endsWith(".xpi"))
    if (files.length !== 1) throw new Error(`Expected exactly one pinned XPI in ${directory}`)
    fs.copyFileSync(path.join(directory, files[0]), path.join(destination, `${slug}.xpi`))
  }
}
const settings = "PRODUCT_BUNDLE_IDENTIFIER = com.zmarn.once.extensionbenchmark; PRODUCT_NAME = Bench; SWIFT_VERSION = 5.0; IPHONEOS_DEPLOYMENT_TARGET = 18.6; SDKROOT = iphoneos; TARGETED_DEVICE_FAMILY = \"1,2\"; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = CY3H964NZQ; SWIFT_OPTIMIZATION_LEVEL = \"-O\"; CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0;"
fs.writeFileSync(path.join(out, "Bench.xcodeproj/project.pbxproj"), `// !$*UTF8*$!
{archiveVersion=1; classes={}; objectVersion=56; objects={
 A00000000000000000000001={isa=PBXProject; buildConfigurationList=A00000000000000000000002; compatibilityVersion="Xcode 14.0"; mainGroup=A00000000000000000000003; targets=(A00000000000000000000004,);};
 A00000000000000000000002={isa=XCConfigurationList; buildConfigurations=(A00000000000000000000005,); defaultConfigurationName=Release;};
 A00000000000000000000005={isa=XCBuildConfiguration; name=Release; buildSettings={${settings}};};
 A00000000000000000000003={isa=PBXGroup; sourceTree="<group>"; children=(A00000000000000000000010,A00000000000000000000011,A00000000000000000000012,A00000000000000000000013,A00000000000000000000014,A00000000000000000000016,A00000000000000000000017,A00000000000000000000018,);};
 A00000000000000000000004={isa=PBXNativeTarget; name=Bench; productName=Bench; productReference=A00000000000000000000014; productType="com.apple.product-type.application"; buildConfigurationList=A00000000000000000000002; buildPhases=(A00000000000000000000006,A00000000000000000000007,);};
 A00000000000000000000006={isa=PBXSourcesBuildPhase; buildActionMask=2147483647; files=(A00000000000000000000020,A00000000000000000000021,A00000000000000000000024,A00000000000000000000026,A00000000000000000000027,A00000000000000000000028,); runOnlyForDeploymentPostprocessing=0;};
 A00000000000000000000007={isa=PBXResourcesBuildPhase; buildActionMask=2147483647; files=(A00000000000000000000022,A00000000000000000000023,); runOnlyForDeploymentPostprocessing=0;};
 A00000000000000000000010={isa=PBXFileReference; path=Bench.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000011={isa=PBXFileReference; path=WebExtensionHost.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000012={isa=PBXFileReference; path=public; sourceTree="<group>"; lastKnownFileType=folder;};
 A00000000000000000000013={isa=PBXFileReference; path=fixture.html; sourceTree="<group>"; lastKnownFileType=text.html;};
 A00000000000000000000014={isa=PBXFileReference; path=Bench.app; sourceTree=BUILT_PRODUCTS_DIR; explicitFileType=wrapper.application;};
 A00000000000000000000015={isa=PBXFileReference; path=ExtensionSupport.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000024={isa=PBXBuildFile; fileRef=A00000000000000000000015;};
 A00000000000000000000016={isa=PBXFileReference; path=WebExtensionManagement.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000017={isa=PBXFileReference; path=WebExtensionInstaller.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000018={isa=PBXFileReference; path=ExtensionArchive.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000026={isa=PBXBuildFile; fileRef=A00000000000000000000016;};
 A00000000000000000000027={isa=PBXBuildFile; fileRef=A00000000000000000000017;};
 A00000000000000000000028={isa=PBXBuildFile; fileRef=A00000000000000000000018;};
 A00000000000000000000020={isa=PBXBuildFile; fileRef=A00000000000000000000010;};
 A00000000000000000000021={isa=PBXBuildFile; fileRef=A00000000000000000000011;};
 A00000000000000000000022={isa=PBXBuildFile; fileRef=A00000000000000000000012;};
 A00000000000000000000023={isa=PBXBuildFile; fileRef=A00000000000000000000013;};
}; rootObject=A00000000000000000000001;}`)
console.log(out)
// Compile only the production AMO entry with the real mobile loader/minifier.
// Copy/HTML plugins require the whole app; neither affects this entry's code.
const webpack = require("webpack")
const config = require("../../../apps/mobile/webpack.config")({}, { mode: "production" })
config.entry = { "amo-page-shim": config.entry["amo-page-shim"] }
config.output = { ...config.output, path: path.join(out, "public"), clean: false }
config.plugins = config.plugins.filter(plugin => plugin instanceof webpack.DefinePlugin)
webpack(config, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1 }
})
