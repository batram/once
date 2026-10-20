// Android-only adaptation of the pinned uBlock bundle. The upstream signed
// archive stays intact for Electron/Lite. GeckoView's built-in extension API
// supplies the trust boundary for this copy; no signature preference is changed.
const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const { batchStartupAdminStorage, prefetchStartupSelfie } = require("./gecko-ublock-startup")

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("uBlock startup changed; review the Android adaptation")
  return source.replace(before, after)
}

function optimizeStorage(source) {
  source = replaceOnce(source, "    const create = async function() {",
    `    const startupSelfie = (${prefetchStartupSelfie.toString()})(io, () => µb.selfieIsInvalid);
    const create = async function() {
        startupSelfie.invalidate();`)
  source = replaceOnce(source, "await io.fromCache('selfie/staticMain')", "await startupSelfie.read('selfie/staticMain')")
  for (const key of ["staticExtFilteringEngine", "staticNetFilteringEngine"]) {
    source = replaceOnce(source, `io.fromCache('selfie/${key}').then`, `startupSelfie.read('selfie/${key}').then`)
  }
  source = replaceOnce(source, "        if ( µb.selfieIsInvalid ) { return false; }",
    "        if ( µb.selfieIsInvalid ) { return false; }\n        const generation = startupSelfie.generation;")
  source = replaceOnce(source, "    const destroy = function(options = {}) {",
    "    const destroy = function(options = {}) {\n        startupSelfie.invalidate();")
  source = replaceOnce(source, "µb.selfieManager = { load, create, destroy };",
    "µb.selfieManager = { load, create, destroy, prepare: () => startupSelfie.prepare() };")
  // PSL's JS implementation is ready immediately. Its WASM implementation
  // explicitly copies any already-loaded buffer when it becomes available.
  // Like the network engine's WASM, it need not delay loading filter data.
  source = replaceOnce(source, `        let result = false;
        try {
            result = await psl.enableWASM(wasmModuleFetcher,
                './lib/publicsuffixlist/wasm/'
            );
        } catch(reason) {
            ubolog(reason);
        }
        if ( result ) {
            ubolog(\`WASM PSL ready \${Date.now()-vAPI.T0} ms after launch\`);
        }`, `        psl.enableWASM(wasmModuleFetcher,
            './lib/publicsuffixlist/wasm/'
        ).then(result => {
            if ( result ) { ubolog('WASM PSL ready'); }
        }).catch(reason => { ubolog(reason); });`)
  // Redirect resources are independent of the three static filter snapshots.
  // Await all of them, retaining upstream's validity checks and fallback. In
  // particular, neither readyToFilter nor network unsuspension moves earlier.
  source = replaceOnce(source, `            const results = await Promise.all([
                loadMain(),`, `            const settled = await Promise.allSettled([
                loadMain(),`)
  source = replaceOnce(source, `            ]);
            if ( results.every(v => v) ) {
                return µb.loadRedirectResources();`, `                µb.loadRedirectResources(),
            ]);
            const failure = settled.find(result => result.status === 'rejected');
            if ( failure !== undefined ) { throw failure.reason; }
            const results = settled.map(result => result.value);
            if ( results.slice(0, 3).every(v => v) && !µb.selfieIsInvalid && generation === startupSelfie.generation ) {
                return results[3];`)
  return source
}

function optimizeStart(source) {
  source = replaceOnce(source, "    await vAPI.storage.get(createDefaultProps()).then",
    "    µb.selfieManager.prepare();\n    await vAPI.storage.get(createDefaultProps()).then")
  source = replaceOnce(source, "// >>>>> start of async/await scope",
    `// >>>>> start of async/await scope
const restoreAdminStorage = (${batchStartupAdminStorage.toString()})(vAPI.adminStorage);`)
  return replaceOnce(source, `} catch (ex) {
    console.trace(ex);
}

// Prime the filtering engines`, `} catch (ex) {
    console.trace(ex);
} finally {
    restoreAdminStorage();
}

// Prime the filtering engines`)
}

function adaptGeckoUblock(source, target, upstreamSha256) {
  const hash = crypto.createHash("sha256").update(upstreamSha256).update(fs.readFileSync(__filename))
    .update(batchStartupAdminStorage.toString()).update(prefetchStartupSelfie.toString()).digest("hex")
  try {
    if (JSON.parse(fs.readFileSync(path.join(target, ".once-bundle.json"), "utf8")).adapterHash === hash) return false
  } catch { /* Not built yet. */ }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"))
  if (manifest.manifest_version !== 2 || manifest.background?.page !== "background.html" ||
      manifest.browser_specific_settings?.gecko?.id !== "uBlock0@raymondhill.net" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error("Expected the pinned uBlock MV2 background; review the Android adaptation")
  }
  const start = optimizeStart(fs.readFileSync(path.join(source, "js/start.js"), "utf8"))
  const storage = optimizeStorage(fs.readFileSync(path.join(source, "js/storage.js"), "utf8"))
  // ensureBuiltIn compares versions, so every adaptation must trigger an update.
  // Keep the same extension identity, permissions, cache formats and user data.
  // uBlock treats a fourth numeric component as a development build. Preserve
  // its upstream runtime version/defaults while Gecko sees the adapter revision.
  manifest.version_name ??= manifest.version
  manifest.version = `${manifest.version}.${parseInt(hash.slice(0, 6), 16)}`
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.staging`)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.cpSync(source, staging, { recursive: true,
    filter: file => !["META-INF", ".once-bundle.json"].includes(path.basename(file)) })
  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
  fs.writeFileSync(path.join(staging, "js/storage.js"), storage)
  fs.writeFileSync(path.join(staging, "js/start.js"), start)
  fs.writeFileSync(path.join(staging, ".once-bundle.json"), JSON.stringify({
    upstreamSha256, adapterHash: hash, version: manifest.version
  }, null, 2))
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(staging, target)
  return true
}

module.exports = { adaptGeckoUblock, optimizeStorage, optimizeStart }
