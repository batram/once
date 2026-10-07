// The command sequence that hands Once's userscripts to Violentmonkey, shared
// by every target that bundles it. Each target reaches Violentmonkey's
// background its own way — Electron through a virtual extension page, Android
// through a relay script added to the bundled copy — and keeps its own record
// of what the last hand-off left behind; the commands and the reconciliation
// between them are the same everywhere.

import { UserscriptEntry, UserscriptsDocument } from "./extensionSettings"
import { AppliedUserscript, InstalledUserscript, planUserscripts } from "./userscriptReconcile"

/** Sends one of Violentmonkey's own dashboard commands and returns its answer. */
export type ViolentmonkeyCommand = (cmd: string, data: unknown) => Promise<unknown>

/** A stable digest of a script's text, used as a record's baseline. */
export type UserscriptDigest = (value: string) => Promise<string>

export interface ViolentmonkeyHandOffResult {
  /** What this hand-off left behind, to pass to the next one. */
  applied: Record<string, AppliedUserscript>
  /** The doc as it should now read, when the dashboard changed it. */
  adopted?: UserscriptsDocument
}

interface ExportedScript {
  script?: {
    props?: { id?: number }
    meta?: { name?: string; namespace?: string }
    config?: { enabled?: number | boolean; removed?: number | boolean }
  }
  code?: string
}

/**
 * Everything Violentmonkey holds, with its code. `ExportZip` is the one
 * command that answers with both in a single round trip; without `values` it
 * carries no stored script data, only the scripts themselves.
 */
async function installedUserscripts(send: ViolentmonkeyCommand): Promise<InstalledUserscript[]> {
  const result = await send("ExportZip", { values: false }) as { items?: ExportedScript[] } | undefined
  if (!Array.isArray(result?.items)) throw new Error("Violentmonkey did not export its scripts")
  const scripts: InstalledUserscript[] = []
  for (const item of result.items) {
    const id = item?.script?.props?.id
    const name = item?.script?.meta?.name
    const enabled = item?.script?.config?.enabled
    if (typeof id !== "number" || !name || typeof item.code !== "string") continue
    if (item.script?.config?.removed) continue
    scripts.push({
      id,
      name,
      namespace: item.script?.meta?.namespace || null,
      code: item.code,
      enabled: enabled !== 0 && enabled !== false
    })
  }
  return scripts
}

/** Writes one script, then reads back what Violentmonkey stored for it. */
async function installUserscript(
  send: ViolentmonkeyCommand,
  script: UserscriptEntry,
  digest: UserscriptDigest
): Promise<AppliedUserscript | undefined> {
  const result = await send("ParseScript", {
    code: script.source, message: "", url: "", from: ""
  }) as { update?: { props?: { id?: number } }; errors?: unknown } | undefined
  const id = result?.update?.props?.id
  if (typeof id !== "number") {
    console.error(`Violentmonkey did not install "${script.name}"`, result?.errors ?? result)
    return undefined
  }
  await send("UpdateScriptInfo", { id, config: { enabled: script.enabled ? 1 : 0 } })
  // The baseline has to be the text Violentmonkey ended up with rather than
  // the text Once sent: an install may normalise it, and the difference would
  // otherwise read as a dashboard edit on the very next hand-off.
  const stored = await send("GetScriptCode", id)
  return {
    id,
    source: await digest(script.source),
    code: await digest(typeof stored === "string" ? stored : script.source),
    enabled: script.enabled
  }
}

/**
 * Violentmonkey's dashboard installs and edits through these commands:
 * `ExportZip` reads every script with its code, `ParseScript` installs or
 * updates by namespace and name, `GetScriptCode` reads one back,
 * `UpdateScriptInfo` toggles it, and `MarkRemoved` with `RemoveScripts`
 * deletes by id.
 *
 * The dashboard is an editor in its own right, so this reconciles rather than
 * overwrites: what Once's doc changed is written, and what the dashboard
 * changed is returned for the caller to save into the doc, where it syncs
 * like any other change. `knownStorage` says the records were kept beside
 * Violentmonkey's own storage, so their scripts going missing is a deletion
 * rather than lost storage.
 */
export async function handUserscriptsToViolentmonkey(
  send: ViolentmonkeyCommand,
  doc: UserscriptsDocument,
  applied: Readonly<Record<string, AppliedUserscript>>,
  digest: UserscriptDigest,
  knownStorage: boolean
): Promise<ViolentmonkeyHandOffResult> {
  const installed = await installedUserscripts(send)
  // Planning is synchronous; every text it compares is digested up front.
  const texts = [...doc.scripts.map((script) => script.source), ...installed.map((script) => script.code)]
  const digests = new Map(await Promise.all(texts.map(async (text) => [text, await digest(text)] as const)))
  const plan = planUserscripts(doc, installed, applied, (text) => digests.get(text) ?? "", knownStorage)
  const next: Record<string, AppliedUserscript> = { ...plan.keep }
  // Deleting takes both commands, as the dashboard's own delete does:
  // `RemoveScripts` purges what is already in Violentmonkey's trash and
  // leaves an installed script running, so it has to be put there first.
  for (const id of plan.remove) await send("MarkRemoved", { id, removed: true })
  if (plan.remove.length > 0) await send("RemoveScripts", plan.remove)
  for (const script of plan.install) {
    const record = await installUserscript(send, script, digest)
    if (record) next[script.id] = record
  }
  for (const { id, enabled } of plan.toggle) {
    await send("UpdateScriptInfo", { id, config: { enabled: enabled ? 1 : 0 } })
  }
  return plan.adopted ? { applied: next, adopted: plan.doc } : { applied: next }
}
