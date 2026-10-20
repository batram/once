
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("uBlock cosmetic snapshot changed; review the Android adaptation")
  return source.replace(before, after)
}

function compactHostnameDB(source) {
  if (!source.includes("static VERSION = 1;")) throw new Error("uBlock hostname cache version changed; review the Android adaptation")
  source = replaceOnce(source, "export class StaticExtFilteringHostnameDB {",
    "import { packHostnameSelfie, unpackHostnameSelfie } from './once-cosmetic-cache.js';\n\nexport class StaticExtFilteringHostnameDB {")
  source = replaceOnce(source, "    #strSlots = [ '' ];",
    "    #packedText = null;\n    #packedOffsets = null;\n    #strSlots = [ '' ];")
  source = replaceOnce(source, "    store(target, s) {", `    store(target, s) {
        // Cache reads retain the binary links. Materialize only when appending.
        if ( Array.isArray(this.#linkedLists) === false ) {
            this.#linkedLists = Array.from(this.#linkedLists);
        }`)
  source = replaceOnce(source, "        this.#strSlots = [ '' ];",
    "        this.#packedText = null;\n        this.#packedOffsets = null;\n        this.#strSlots = [ '' ];")
  source = replaceOnce(source, "    #retrieveFromSlot(out, iList) {", `    #stringAt(index, cache = true) {
        const cached = this.#strSlots[index];
        if ( cached !== undefined || this.#packedOffsets === null ) { return cached; }
        if ( index + 1 >= this.#packedOffsets.length ) { throw new TypeError('Bad selfie string index'); }
        const value = this.#packedText.slice(this.#packedOffsets[index], this.#packedOffsets[index + 1]);
        if ( cache ) { this.#strSlots[index] = value; }
        return value;
    }

    #retrieveFromSlot(out, iList) {`)
  source = replaceOnce(source, "out.add(this.#strSlots[iStr]);", "out.add(this.#stringAt(iStr));")
  source = replaceOnce(source, "    toSelfie() {\n        return {", "    toSelfie() {\n        return packHostnameSelfie({")
  source = replaceOnce(source, "            strSlots: this.#strSlots,",
    "            strSlots: Array.from({ length: this.#strSlots.length }, (_, i) => this.#stringAt(i, false)),")
  source = replaceOnce(source, "            size: this.size\n        };", "            size: this.size\n        });")
  source = replaceOnce(source, `        if ( selfie.VERSION !== StaticExtFilteringHostnameDB.VERSION ) {
            throw new TypeError('Bad selfie');
        }`, `        selfie = unpackHostnameSelfie(selfie);
        this.#packedText = selfie.packedText;
        this.#packedOffsets = selfie.packedOffsets;`)
  return source
}

function compactGenericMap(source) {
  source = replaceOnce(source, "import { StaticExtFilteringHostnameDB }", "import { packFilterIndex, unpackFilterIndex } from './once-cosmetic-cache.js';\n\nimport { StaticExtFilteringHostnameDB }")
  source = replaceOnce(source, "lowlyGeneric: this.lowlyGeneric,", "lowlyGeneric: packFilterIndex(this.lowlyGeneric),")
  return replaceOnce(source, "this.lowlyGeneric = selfie.lowlyGeneric;", "this.lowlyGeneric = unpackFilterIndex(selfie.lowlyGeneric);")
}

function scheduleLegacySelfieRewrite(source) {
  source = replaceOnce(source, "        const generation = startupSelfie.generation;",
    "        const generation = startupSelfie.generation;\n        let legacySelfie = false;")
  source = replaceOnce(source, `startupSelfie.read('selfie/staticExtFilteringEngine').then(selfie =>
                    staticExtFilteringEngine.fromSelfie(selfie)
                )`, `startupSelfie.read('selfie/staticExtFilteringEngine').then(selfie => {
                    legacySelfie = [ selfie?.cosmetic?.specificFilters, selfie?.scriptlets, selfie?.httpHeaders, selfie?.html ]
                        .some(db => db?.VERSION === 1);
                    return staticExtFilteringEngine.fromSelfie(selfie);
                })`)
  return replaceOnce(source, "                return results[3];", `                // Keep the first request off the migration path. Existing
                // invalidation replaces this timer if the filters change.
                if ( results[3] && legacySelfie ) {
                    createTimer.onidle({ sec: Math.max(60, µb.hiddenSettings.selfieDelayInSeconds) }, { timeout: 10000 });
                }
                return results[3];`)
}

module.exports = { compactHostnameDB, compactGenericMap, scheduleLegacySelfieRewrite }
