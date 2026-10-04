// Creates a separate app/project; production sources and user app data stay intact.
const fs = require("node:fs")
const path = require("node:path")
const { fixture } = require("./extension-benchmark-fixture")
const root = path.resolve(__dirname, "../../..")
const out = path.resolve(process.argv[2] || "/tmp/once-extension-benchmark-ios")
fs.mkdirSync(path.join(out, "Bench.xcodeproj"), { recursive: true })
fs.writeFileSync(path.join(out, "Bench.swift"), fs.readFileSync(path.join(__dirname, "extension-benchmark.swift"), "utf8") + "\n" + fs.readFileSync(path.join(__dirname, "ios-filter-regression.swift"), "utf8"))
const hostSource = fs.readFileSync(path.join(root, "apps/mobile/ios/App/App/WebExtensionHost.swift"), "utf8")
fs.writeFileSync(path.join(out, "WebExtensionHost.swift"), hostSource)
// Only replace Capacitor's dictionary type; exporter/shim implementations are verbatim.
fs.writeFileSync(path.join(out, "ExtensionSupport.swift"), fs.readFileSync(path.join(root, "apps/mobile/ios/App/App/ExtensionSupport.swift"), "utf8").replace("import Capacitor", "typealias JSObject = [String: Any]"))
fs.writeFileSync(path.join(out, "fixture.html"), fixture())
for (const name of ["ublock-origin-lite", "darkreader", "sponsorblock", "violentmonkey"]) {
  const source = path.join(root, "vendor/extensions", name === "ublock-origin-lite" ? name : `ios/${name}`)
  fs.cpSync(source, path.join(out, "public/extensions", name), { recursive: true })
}
const settings = "PRODUCT_BUNDLE_IDENTIFIER = com.zmarn.once.extensionbenchmark; PRODUCT_NAME = Bench; SWIFT_VERSION = 5.0; IPHONEOS_DEPLOYMENT_TARGET = 18.6; SDKROOT = iphoneos; TARGETED_DEVICE_FAMILY = \"1,2\"; GENERATE_INFOPLIST_FILE = YES; INFOPLIST_KEY_UILaunchScreen_Generation = YES; CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = CY3H964NZQ; SWIFT_OPTIMIZATION_LEVEL = \"-O\"; CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0;"
fs.writeFileSync(path.join(out, "Bench.xcodeproj/project.pbxproj"), `// !$*UTF8*$!
{archiveVersion=1; classes={}; objectVersion=56; objects={
 A00000000000000000000001={isa=PBXProject; buildConfigurationList=A00000000000000000000002; compatibilityVersion="Xcode 14.0"; mainGroup=A00000000000000000000003; targets=(A00000000000000000000004,);};
 A00000000000000000000002={isa=XCConfigurationList; buildConfigurations=(A00000000000000000000005,); defaultConfigurationName=Release;};
 A00000000000000000000005={isa=XCBuildConfiguration; name=Release; buildSettings={${settings}};};
 A00000000000000000000003={isa=PBXGroup; sourceTree="<group>"; children=(A00000000000000000000010,A00000000000000000000011,A00000000000000000000012,A00000000000000000000013,A00000000000000000000014,);};
 A00000000000000000000004={isa=PBXNativeTarget; name=Bench; productName=Bench; productReference=A00000000000000000000014; productType="com.apple.product-type.application"; buildConfigurationList=A00000000000000000000002; buildPhases=(A00000000000000000000006,A00000000000000000000007,);};
 A00000000000000000000006={isa=PBXSourcesBuildPhase; buildActionMask=2147483647; files=(A00000000000000000000020,A00000000000000000000021,A00000000000000000000024,); runOnlyForDeploymentPostprocessing=0;};
 A00000000000000000000007={isa=PBXResourcesBuildPhase; buildActionMask=2147483647; files=(A00000000000000000000022,A00000000000000000000023,); runOnlyForDeploymentPostprocessing=0;};
 A00000000000000000000010={isa=PBXFileReference; path=Bench.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000011={isa=PBXFileReference; path=WebExtensionHost.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000012={isa=PBXFileReference; path=public; sourceTree="<group>"; lastKnownFileType=folder;};
 A00000000000000000000013={isa=PBXFileReference; path=fixture.html; sourceTree="<group>"; lastKnownFileType=text.html;};
 A00000000000000000000014={isa=PBXFileReference; path=Bench.app; sourceTree=BUILT_PRODUCTS_DIR; explicitFileType=wrapper.application;};
 A00000000000000000000015={isa=PBXFileReference; path=ExtensionSupport.swift; sourceTree="<group>"; lastKnownFileType=sourcecode.swift;};
 A00000000000000000000024={isa=PBXBuildFile; fileRef=A00000000000000000000015;};
 A00000000000000000000020={isa=PBXBuildFile; fileRef=A00000000000000000000010;};
 A00000000000000000000021={isa=PBXBuildFile; fileRef=A00000000000000000000011;};
 A00000000000000000000022={isa=PBXBuildFile; fileRef=A00000000000000000000012;};
 A00000000000000000000023={isa=PBXBuildFile; fileRef=A00000000000000000000013;};
}; rootObject=A00000000000000000000001;}`)
console.log(out)
