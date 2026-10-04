// The page actions of the add-ons this build carries, read from their
// packages alone. A first start installs these add-ons enabled, so a shell
// can offer their actions before any panel has loaded the add-on document:
// the browser extensions put them in the page context menu at install.
import { AddonCondition, addonContributionId } from "@once/core"
import type { BundledAddonFiles } from "./bundledAddons"
import { readBundledAddon } from "./localAddonPackage"

export interface BundledPageAction {
  id: string
  label: string
  when?: AddonCondition
}

/** Menu actions as `mountAddons` registers them: no tagging or read state, and a script for scripted runs. */
export async function bundledPageActions(bundled: readonly BundledAddonFiles[]): Promise<BundledPageAction[]> {
  const actions: BundledPageAction[] = []
  for (const { files } of bundled) {
    let manifest
    try { manifest = (await readBundledAddon(files)).entry.manifest } catch { continue }
    for (const contribution of manifest.contributions) {
      if (contribution.kind !== "action" || !contribution.surfaces.includes("menu")) continue
      const run = contribution.run
      if ("tag" in run || "setReadState" in run) continue
      if (("message" in run || "tray" in run) && !manifest.script) continue
      actions.push({ id: addonContributionId(manifest.id, contribution.id), label: contribution.label,
        ...(contribution.when ? { when: contribution.when } : {}) })
    }
  }
  return actions
}
