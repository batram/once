const fs = require("node:fs")
const path = require("node:path")

/** Adapt packaging, keeping the upstream implementation and settings schema. */
function adaptIOSExtension(target, packageInfo) {
  const file = path.join(target, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
  if (manifest.version !== packageInfo.version) throw new Error(`Unexpected ${packageInfo.name} version`)
  const adaptations = []
  if (packageInfo.background === "event-page") {
    if (!manifest.background?.service_worker) throw new Error("Expected an upstream MV3 background worker")
    // WebKit accepts MV3 event pages. Keep upstream MV3 lifecycle/state handling,
    // while allowing the same compatibility bootstrap in pages and background.
    manifest.background = { scripts: [manifest.background.service_worker], persistent: false }
    adaptations.push("MV3 service worker hosted as a WebKit event page")
  }
  if (packageInfo.background === "violentmonkey-event-page") {
    if (manifest.manifest_version !== 2 || manifest.background?.scripts?.join() !== "background/index.js") {
      throw new Error("Expected the pinned Violentmonkey MV2 background")
    }
    manifest.background = { scripts: ["once-compat.js", ...manifest.background.scripts], persistent: false }
    const backgroundFile = path.join(target, "background/index.js")
    const background = fs.readFileSync(backgroundFile, "utf8")
    const marker = "a.handleCommandMessage=Vm,a.deepCopy=aa,le.runtime.onMessage.addListener(Vm)"
    const downloadsQuery = 'Gi.contains({permissions:["downloads"]})'
    // Version-pinned export of the existing value-opener function. Recovery must
    // not call injection commands: they can execute content-realm scripts again.
    if (!background.includes("async function is(e,a,t){const o=+e[0]&&await $o.value.getMulti(e)") ||
        !background.includes("GetScript:Ls") || !background.includes("$a=e=>e.grant.some(Aa.test,Aa)") ||
        background.split(downloadsQuery).length !== 2 || background.split(marker).length !== 2) {
      throw new Error("Violentmonkey lifecycle adapter needs review")
    }
    const hook = "a.onceRestoreValueOpeners=async(ids,tabId,frameId)=>{ids=ids.filter(id=>{const script=Ls({id});return script&&$a(script.meta)});const values=await $o.value.getMulti(ids);await is(ids.map(id=>({id,values:values[id]||{}})),tabId,frameId)},"
    // Resolve this unsupported capability without touching WebKit's API wrappers
    // during background initialization (including after a page reload).
    fs.writeFileSync(backgroundFile, background.replace(marker, hook + marker).replace(downloadsQuery, "Promise.resolve(false)"))
    delete manifest.commands
    manifest.description = `${manifest.description} ${packageInfo.compatibility}`
    fs.copyFileSync(path.join(__dirname, "ios-violentmonkey-compat.js"), path.join(target, "once-compat.js"))
    adaptations.push("MV2 event page with capability adapter", "Background-only export of upstream value-opener registration for lifecycle recovery", "Unsupported downloads permission resolved as false at initialization", "Desktop keyboard commands omitted")
  }
  fs.copyFileSync(path.join(__dirname, "extension-licenses", packageInfo.directory + ".txt"), path.join(target, "LICENSE.once-bundle.txt"))
  fs.writeFileSync(path.join(target, "ONCE-PACKAGE.json"), JSON.stringify({
    ...packageInfo, adaptations
  }, null, 2) + "\n")
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
}
module.exports = { adaptIOSExtension }
