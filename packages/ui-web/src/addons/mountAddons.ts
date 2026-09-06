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
import { renderAddonOptions, readDevAddonOptions, devAddonEnabled, DEV_OPTIONS_EVENT, DevAddonControls } from "../settings/addonOptions"
import { bindAddonDirectories } from "../settings/addonDirectories"
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
import { AddonTrays } from "./AddonTrays"
import { addonStoryContent } from "./addonStoryContent"
import { registerAddonCollector } from "./addonCollectors"
import { BadgeScheduler } from "./badgeScheduler"
import { AddonCandidate, AddonReconciler, AddonRegistration } from "./AddonReconciler"
import { setAddonRetry, setAddonStatus } from "./addonStatus"
import { configureAddonPackages, verifiedAddonScript } from "./addonPackage"

/** Development add-ons as the host read them from disk: manifest plus code. */
export interface DevAddonSource {
  list(): Promise<{ directory: string; manifest: unknown; code: string | null; error?: string; removable?: boolean }[]>
  onChanged(listener: () => void): () => void
  pickDirectory?(): Promise<void>
  removeDirectory?(directory: string): Promise<void>
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
  configureAddonPackages(options.sandboxUrl)
  let forms = ""
  let refreshing: Promise<void> = Promise.resolve()
  const showDirectories = bindAddonDirectories(options.devAddons)
  const reconciler = new AddonReconciler(
    ({ entry, code }) => registerManifest(client, entry, options, code ?? null),
    (collectors) => {
      refreshStoryElements()
      if (collectors) {
        addCollectorColorStyles()
        void client.reloadStories("cache-first")
      }
    }
  )
  const apply = async (): Promise<void> => {
    const doc = await client.getAddons()
    const candidates: AddonCandidate[] = doc.addons.map((entry) => ({ entry }))
    const devIds = new Set<string>()
    const devControls = new Map<string, DevAddonControls>()
    const directories = await options.devAddons?.list() ?? []
    showDirectories(directories)
    for (const dev of directories) {
      const read = dev.error ? null : readAddonManifest(dev.manifest)
      if (!read || !read.ok) {
        const why = dev.error ?? (read ? read.reports.map((r) => `${r.path} ${r.message}`).join("; ") : "")
        report(`Development add-on in ${dev.directory} was not loaded`, why)
        continue
      }
      if (candidates.some(({ entry }) => entry.manifest.id === read.manifest.id)) {
        report(`Development add-on ${read.manifest.id} duplicates an installed add-on`, dev.directory)
        continue
      }
      devIds.add(read.manifest.id)
      devControls.set(read.manifest.id, { directory: dev.directory,
        ...(dev.removable && options.devAddons?.removeDirectory
          ? { unload: async () => { await options.devAddons?.removeDirectory?.(dev.directory) } } : {}) })
      candidates.push({ entry: { enabled: devAddonEnabled(read.manifest.id), manifest: read.manifest, options: readDevAddonOptions(read.manifest.id) }, code: dev.code })
    }
    await reconciler.apply(candidates)
    const nextForms = JSON.stringify([candidates.map(({ entry }) => entry), directories.map(({ directory, removable }) => ({ directory, removable }))])
    if (forms !== nextForms) {
      forms = nextForms
      renderAddonOptions(client, candidates.map(candidate => candidate.entry), devIds, devControls)
    }
  }
  const refresh = (): void => {
    refreshing = refreshing.then(apply).catch((error) => report("Add-ons could not be loaded", error))
  }
  setAddonRetry((id) => {
    void reconciler.retry(id).then(refresh).catch(error => report("Add-on could not be retried", error))
  })
  refresh()
  window.addEventListener(DEV_OPTIONS_EVENT, (event) => {
    const id = (event as CustomEvent<string>).detail
    if (id) void reconciler.retry(id).then(refresh)
    else refresh()
  })
  client.subscribe("settingsChanged", ({ section }) => {
    if (section === "addons") refresh()
  })
  options.devAddons?.onChanged(() => {
    refresh()
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
): Promise<AddonRegistration> {
  const { manifest } = entry
  const releases: (() => void)[] = []
  const lifecycle: { trays?: AddonTrays } = {}
  const sandbox = await sandboxFor(client, entry, options, devCode, () => lifecycle.trays?.reset())
  const storyTrays = new AddonTrays(manifest, sandbox)
  lifecycle.trays = storyTrays
  releases.push(() => storyTrays.dispose())
  if (sandbox) releases.push(() => sandbox.dispose())
  const scheduler = sandbox ? new BadgeScheduler(manifest.id, sandbox, viewOf) : null
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
      const run = (row: StoryListItem) => "tray" in contribution.run ? storyTrays.toggle(row, contribution.run.tray) : runAction(manifest, contribution.run, row, sandbox)
      if (("message" in contribution.run || "tray" in contribution.run) && !sandbox) continue
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
          render: (row) => {
            if (!applies(row)) return null
            const button = actionButton(contribution.label, contribution.icon, () => run(row))
            if ("tray" in contribution.run) {
              button.dataset.addonTrayButton = addonContributionId(manifest.id, contribution.run.tray)
              button.setAttribute("aria-expanded", String(storyTrays.expanded(row.story.href, contribution.run.tray)))
            }
            return button
          }
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
  return {
    dispose: () => { for (const release of releases) release() },
    updateOptions: (next) => { entry.options = next.options; storyTrays.reset(); sandbox?.updateSettings() }
  }
}

/** The add-on's sandbox, with its code fetched and checked; null when it has none or cannot run here. */
async function sandboxFor(
  client: OnceClient,
  entry: AddonEntry,
  options: MountAddonsOptions,
  devCode: string | null,
  resetTrays: () => void
): Promise<AddonSandbox | null> {
  const { manifest } = entry
  if (!manifest.script) { setAddonStatus(manifest.id, "declarative"); return null }
  if (!options.sandboxUrl) {
    report(`Add-on ${manifest.name} needs a script, which this platform cannot run yet`, "no sandbox page")
    setAddonStatus(manifest.id, "unavailable", "Configure this platform's sandbox to run scripts")
    return null
  }
  // A development add-on's code came from disk with the manifest; nothing to fetch.
  const code = devCode ?? await loadScript(client, manifest)
  if (code === null) { setAddonStatus(manifest.id, "unavailable", "Script could not be loaded; retry when online"); return null }
  const settings = () => manifest.settings
    ? validateConfig(manifest.settings, entry.options ?? {}) as Record<string, unknown> : {}
  const grants = grantedFetchPatterns(manifest)
  setAddonStatus(manifest.id, "idle")
  return new AddonSandbox(manifest.id, options.sandboxUrl, code, settings, {
    perform: (op, signal) => {
      if (op.name === "request") return client.requestAddonConnection(manifest, settings(), op.connection, op.request, signal)
      if (op.name === "story.content") return addonStoryContent(client, op.href, signal)
      return performOperation(client, manifest, grants, op)
    },
    report: (message) => LoaderInsights.showErrorMessage(message, "")
  }, (state, error) => {
    if (state === "failed" || state === "disabled") resetTrays()
    setAddonStatus(manifest.id, state, error)
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
  if (op.name === "storage.get") {
    const entry = (await client.getAddons()).addons.find((candidate) => candidate.manifest.id === manifest.id)
    if (!entry) throw new Error("the add-on is no longer installed")
    return entry.storage?.[op.key]
  }
  await client.updateAddons((doc) => {
    const entry = doc.addons.find((candidate) => candidate.manifest.id === manifest.id)
    if (!entry || !entry.enabled) throw new Error("the add-on is no longer enabled")
    const storage: Record<string, unknown> = Object.fromEntries(
      Object.entries(entry.storage ?? {}).filter(([key]) => key !== op.key)
    )
    if (op.value !== undefined) storage[op.key] = op.value
    if (JSON.stringify(storage).length > SANDBOX_LIMITS.storageBytes) throw new Error("the add-on's storage is full")
    return {
      ...doc,
      addons: doc.addons.map((candidate) => (candidate === entry ? { ...candidate, storage } : candidate))
    }
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
  try {
    return await verifiedAddonScript(client, manifest)
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
      BadgeScheduler.show(row, manifest.id, op.contribution, op.text)
      return
  }
  return undefined
}
