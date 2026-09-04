import { OnceClient } from "@once/app"
import {
  AddonEntry,
  AddonManifest,
  AddonRun,
  MatchPatternSet,
  SANDBOX_LIMITS,
  SandboxOperation,
  StoryContribution,
  StoryView,
  addonContributionId,
  grantedFetchPatterns,
  projectStoryView,
  readAddonManifest,
  renderAddonTemplate,
  storyMatchesCondition,
  validateConfig
} from "@once/core"
import { renderAddonOptions } from "../settings/addonOptions"
import { getOnceClient } from "../client"
import { registerStoryAction } from "../menu/storyActionRegistry"
import { StoryHistory } from "../story/StoryHistory"
import type { StoryListItem } from "../story/StoryListItem"
import { registerStoryElement, refreshStoryElements } from "../story/storyElements"
import { createIconButton } from "../story/storyRowMarkup"
import { searchStories } from "../story/storySearch"
import { LoaderInsights } from "../shell/LoaderInsights"
import { addCollectorColorStyles } from "../collectorStyles"
import { AddonSandbox } from "./AddonSandbox"
import { registerAddonCollector } from "./addonCollectors"
import { BadgeScheduler } from "./badgeScheduler"

/** Development add-ons as the host read them from disk: manifest plus code. */
export interface DevAddonSource {
  list(): Promise<{ directory: string; manifest: unknown; code: string | null; error?: string }[]>
  onChanged(listener: () => void): () => void
}

export interface MountAddonsOptions {
  /** The platform's sandbox page; absent means scripted add-ons stay off here. */
  sandboxUrl?: string
  /** Development add-ons, registered beside the document's and never stored. */
  devAddons?: DevAddonSource
}

/**
 * Turns the `addons` document into live contributions: every enabled
 * manifest's story elements and actions are registered with the row and
 * action registries, and re-registered whenever the document changes.
 * Declarative contributions render from the manifest alone; a manifest with
 * a script gets a sandbox, created on first use, for `message` actions and
 * computed badges.
 */
export function mountAddons(client: OnceClient, options: MountAddonsOptions = {}): void {
  const release: (() => void)[] = []
  let collectorsSeen = false
  const apply = async (): Promise<void> => {
    for (const fn of release.splice(0)) fn()
    const doc = await client.getAddons()
    let collectorsNow = false
    for (const entry of doc.addons) {
      if (!entry.enabled) continue
      release.push(...await registerManifest(client, entry, options))
      collectorsNow ||= entry.manifest.collectors.length > 0 && entry.manifest.script !== undefined
    }
    for (const dev of await options.devAddons?.list() ?? []) {
      const read = dev.error ? null : readAddonManifest(dev.manifest)
      if (!read || !read.ok) {
        const why = dev.error ?? (read ? read.reports.map((r) => `${r.path} ${r.message}`).join("; ") : "")
        report(`Development add-on in ${dev.directory} was not loaded`, why)
        continue
      }
      release.push(...await registerManifest(client, { enabled: true, manifest: read.manifest }, options, dev.code))
      collectorsNow ||= read.manifest.collectors.length > 0 && dev.code !== null
    }
    renderAddonOptions(client, doc.addons)
    refreshStoryElements()
    // Sources naming an add-on collector resolve against the registry at
    // load time, so a change in the set is a reason to load again.
    if (collectorsNow || collectorsSeen) {
      addCollectorColorStyles()
      void client.reloadStories("cache-first")
    }
    collectorsSeen = collectorsNow
  }
  void apply().catch((error) => report("Add-ons could not be loaded", error))
  client.subscribe("settingsChanged", ({ section }) => {
    if (section === "addons") void apply().catch((error) => report("Add-ons could not be reloaded", error))
  })
  options.devAddons?.onChanged(() => {
    void apply().catch((error) => report("Development add-ons could not be reloaded", error))
  })
}

function report(message: string, error: unknown): void {
  LoaderInsights.showErrorMessage(
    message,
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  )
}

function viewOf(row: StoryListItem): StoryView {
  return projectStoryView(row.story, row.dataset.redirected_url || row.story.href)
}

function rowFor(href: string): StoryListItem | undefined {
  for (const row of document.querySelectorAll<StoryListItem>("story-item")) {
    if (row.story.href === href) return row
  }
  return undefined
}

async function registerManifest(
  client: OnceClient,
  entry: AddonEntry,
  options: MountAddonsOptions,
  devCode: string | null = null
): Promise<(() => void)[]> {
  const { manifest } = entry
  const releases: (() => void)[] = []
  const sandbox = await sandboxFor(client, entry, options, devCode)
  if (sandbox) releases.push(() => sandbox.dispose())
  const scheduler = sandbox ? new BadgeScheduler(sandbox, viewOf) : null
  if (sandbox) {
    for (const collector of manifest.collectors) {
      try {
        releases.push(registerAddonCollector(manifest, collector, sandbox))
      } catch (error) {
        report(`Add-on ${manifest.name} could not register collector ${collector.id}`, error)
      }
    }
  }
  releases.push(renderPanelActions(manifest, sandbox))

  for (const contribution of manifest.contributions) {
    const id = addonContributionId(manifest.id, contribution.id)
    if (contribution.kind === "action") {
      const applies = (row: StoryListItem) => storyMatchesCondition(contribution.when, viewOf(row))
      const run = (row: StoryListItem) => runAction(manifest, contribution.run, row, sandbox)
      if ("message" in contribution.run && !sandbox) continue
      releases.push(registerStoryAction({
        id,
        label: contribution.label,
        group: contribution.group,
        surfaces: contribution.surfaces,
        appliesTo: applies,
        run
      }))
      if (contribution.surfaces.includes("button")) {
        releases.push(registerStoryElement({
          id,
          slot: "button",
          render: (row) => (applies(row) ? actionButton(contribution.label, contribution.icon, () => run(row)) : null)
        }))
      }
    } else if (contribution.kind === "badge" && contribution.compute !== undefined) {
      if (!scheduler) continue
      const compute = contribution.compute
      releases.push(registerStoryElement({
        id,
        slot: "title",
        render: (row) => {
          if (!storyMatchesCondition(contribution.when, viewOf(row))) return null
          const element = document.createElement("span")
          element.className = "addon_badge"
          element.dataset.addonPending = ""
          scheduler.request(compute, row, element)
          return element
        }
      }))
    } else {
      releases.push(registerStoryElement(textElement(id, contribution)))
    }
  }
  return releases
}

/** The add-on's sandbox, with its code fetched and checked; null when it has none or cannot run here. */
async function sandboxFor(
  client: OnceClient,
  entry: AddonEntry,
  options: MountAddonsOptions,
  devCode: string | null
): Promise<AddonSandbox | null> {
  const { manifest } = entry
  if (!manifest.script) return null
  if (!options.sandboxUrl) {
    report(`Add-on ${manifest.name} needs a script, which this platform cannot run yet`, "no sandbox page")
    return null
  }
  // A development add-on's code came from disk with the manifest; nothing to fetch.
  const code = devCode ?? await loadScript(client, manifest)
  if (code === null) return null
  const settings = manifest.settings
    ? validateConfig(manifest.settings, entry.options ?? {}) as Record<string, unknown>
    : {}
  const grants = grantedFetchPatterns(manifest)
  return new AddonSandbox(manifest.id, options.sandboxUrl, code, () => settings, {
    perform: (op) => performOperation(client, manifest, grants, op),
    report: (message) => LoaderInsights.showErrorMessage(message, "")
  })
}

/** Toolbar buttons for the panel actions; each opens its URL or asks the script. */
function renderPanelActions(manifest: AddonManifest, sandbox: AddonSandbox | null): () => void {
  const host = document.querySelector<HTMLElement>("#addon_panel_actions")
  const buttons: HTMLElement[] = []
  for (const action of manifest.panelActions) {
    if ("message" in action.run && !sandbox) continue
    const button = createIconButton(action.label, "addon_panel_btn", action.icon ?? "link")
    button.classList.add("bar_btn")
    button.dataset.storyElement = addonContributionId(manifest.id, action.id)
    button.addEventListener("click", () => {
      if ("open" in action.run) {
        getOnceClient().openUrl(action.run.open, "blank")
      } else if (sandbox) {
        const message = action.run.message
        void sandbox.ensure()
          .then((session) => session.panelInvoke(message))
          .catch((error) => report(`Add-on ${manifest.name} could not run ${message}`, error))
      }
    })
    host?.append(button)
    buttons.push(button)
  }
  return () => {
    for (const button of buttons) button.remove()
  }
}

/** Storage lives on the add-on's entry in the synced document, capped by size. */
async function storageOperation(
  client: OnceClient,
  manifest: AddonManifest,
  op: Extract<SandboxOperation, { name: "storage.get" | "storage.set" }>
): Promise<unknown> {
  const doc = await client.getAddons()
  const entry = doc.addons.find((candidate) => candidate.manifest.id === manifest.id)
  if (!entry) throw new Error("the add-on is no longer installed")
  if (op.name === "storage.get") return entry.storage?.[op.key]
  const storage: Record<string, unknown> = Object.fromEntries(
    Object.entries(entry.storage ?? {}).filter(([key]) => key !== op.key)
  )
  if (op.value !== undefined) storage[op.key] = op.value
  if (JSON.stringify(storage).length > SANDBOX_LIMITS.storageBytes) throw new Error("the add-on's storage is full")
  await client.saveAddons({
    ...doc,
    addons: doc.addons.map((candidate) => (candidate === entry ? { ...candidate, storage } : candidate))
  })
  return undefined
}

/**
 * The add-on's code, from this device's cache when the hash is already known
 * here, otherwise fetched, checked against the manifest's hash, and kept. A
 * synced entry whose code cannot be fetched here is installed elsewhere and
 * stays off on this device until it can be.
 */
async function loadScript(client: OnceClient, manifest: AddonManifest): Promise<string | null> {
  const script = manifest.script
  if (!script) return null
  const cached = await client.getAddonScript(script.integrity).catch(() => null)
  if (cached !== null) return cached
  try {
    const code = await client.fetchText(script.url)
    if (code.length > SANDBOX_LIMITS.code) throw new Error("the script is too large")
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))
    const integrity = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`
    if (integrity !== script.integrity) throw new Error(`integrity mismatch: got ${integrity}`)
    await client.storeAddonScript(script.integrity, code).catch(() => undefined)
    return code
  } catch (error) {
    report(`Add-on ${manifest.name} is installed but unavailable here: its script could not be loaded`, error)
    return null
  }
}

function actionButton(label: string, icon: string | undefined, run: () => void): HTMLElement {
  const button = createIconButton(label, "addon_btn", icon ?? "link")
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    run()
  })
  return button
}

function textElement(id: string, contribution: Extract<StoryContribution, { kind: "badge" | "line" }>) {
  return {
    id,
    slot: contribution.kind === "badge" ? "title" as const : "line" as const,
    render: (row: StoryListItem): HTMLElement | null => {
      const view = viewOf(row)
      if (!storyMatchesCondition(contribution.when, view)) return null
      const text = renderAddonTemplate(contribution.text ?? "", view, "text").trim()
      if (!text) return null
      const element = document.createElement(contribution.kind === "badge" ? "span" : "div")
      element.className = contribution.kind === "badge" ? "addon_badge" : "addon_line"
      element.textContent = text
      return element
    }
  }
}

function runAction(manifest: AddonManifest, run: AddonRun, row: StoryListItem, sandbox: AddonSandbox | null): void {
  const view = viewOf(row)
  try {
    if ("message" in run) {
      if (!sandbox) return
      row.read_btn.classList.add("user_interaction")
      void sandbox.ensure()
        .then((session) => session.invoke(run.message, view))
        .catch((error) => report(`Add-on ${manifest.name} could not run ${run.message}`, error))
    } else if ("open" in run) {
      const target = run.target === "blank" ? "blank" : run.target === "middle" ? "middle" : "_self"
      row.read_btn.classList.add("user_interaction")
      getOnceClient().openUrl(renderAddonTemplate(run.open, view, "url"), target)
    } else if ("copy" in run) {
      void navigator.clipboard.writeText(renderAddonTemplate(run.copy, view, "text"))
    } else if ("search" in run) {
      searchStories(renderAddonTemplate(run.search, view, "text"))
    } else if ("tag" in run) {
      addTag(row, run.tag)
    } else if ("setReadState" in run) {
      setReadState(row, run.setReadState)
    }
  } catch (error) {
    report(`Add-on ${manifest.name} could not run its action`, error)
  }
}

function addTag(row: StoryListItem, tag: string): void {
  const tags = row.story.tags ?? []
  if (tags.some((existing) => existing.text === tag)) return
  void getOnceClient().persistStoryChange(row.story.href, "tags", [...tags, { class: "category", text: tag }])
}

function setReadState(row: StoryListItem, state: "unread" | "read" | "skipped"): void {
  const previous = row.story.read_state
  if (previous === state) return
  row.read_btn.classList.add("user_interaction")
  StoryHistory.instance?.story_change(row.story, state, previous)
  void getOnceClient().persistStoryChange(row.story.href, "read_state", state)
}

/** What a script asked for, already vetted for shape and scope by the session. */
async function performOperation(
  client: OnceClient,
  manifest: AddonManifest,
  grants: MatchPatternSet,
  op: SandboxOperation
): Promise<unknown> {
  const row = rowFor(op.href)
  switch (op.name) {
    case "fetch": {
      if (!grants.matches(op.url)) throw new Error(`no fetch: grant covers ${op.url}`)
      const text = await client.fetchText(op.url)
      if (text.length > SANDBOX_LIMITS.fetchBytes) throw new Error("the response is too large")
      return { status: 200, text }
    }
    case "storage.get":
    case "storage.set":
      return storageOperation(client, manifest, op)
    case "openUrl":
      row?.read_btn.classList.add("user_interaction")
      getOnceClient().openUrl(op.url, op.target === "blank" ? "blank" : op.target === "middle" ? "middle" : "_self")
      return
    case "copyText":
      void navigator.clipboard.writeText(op.text)
      return
    case "search":
      searchStories(op.query)
      return
    case "notify":
      LoaderInsights.showErrorMessage(op.text, "")
      return
    case "setReadState":
      if (row) setReadState(row, op.state)
      return
    case "toggleBookmark":
      row?.toggleBookmark()
      return
    case "addTag":
      if (row) addTag(row, op.tag)
      return
    case "updateBadge":
      BadgeScheduler.show(row, op.contribution, op.text)
      return
  }
  return undefined
}
