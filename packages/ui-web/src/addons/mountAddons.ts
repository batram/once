import { OnceClient } from "@once/app"
import {
  AddonManifest,
  AddonRun,
  SANDBOX_LIMITS,
  SandboxOperation,
  StoryContribution,
  StoryView,
  addonContributionId,
  projectStoryView,
  renderAddonTemplate,
  storyMatchesCondition
} from "@once/core"
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

export interface MountAddonsOptions {
  /** The platform's sandbox page; absent means scripted add-ons stay off here. */
  sandboxUrl?: string
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
      release.push(...await registerManifest(client, entry.manifest, options))
      collectorsNow ||= entry.manifest.collectors.length > 0 && entry.manifest.script !== undefined
    }
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
  manifest: AddonManifest,
  options: MountAddonsOptions
): Promise<(() => void)[]> {
  const releases: (() => void)[] = []
  const sandbox = await sandboxFor(client, manifest, options)
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
  manifest: AddonManifest,
  options: MountAddonsOptions
): Promise<AddonSandbox | null> {
  if (!manifest.script) return null
  if (!options.sandboxUrl) {
    report(`Add-on ${manifest.name} needs a script, which this platform cannot run yet`, "no sandbox page")
    return null
  }
  let code: string
  try {
    code = await client.fetchText(manifest.script.url)
    if (code.length > SANDBOX_LIMITS.code) throw new Error("the script is too large")
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))
    const integrity = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`
    if (integrity !== manifest.script.integrity) {
      throw new Error(`integrity mismatch: got ${integrity}`)
    }
  } catch (error) {
    report(`Add-on ${manifest.name} could not load its script`, error)
    return null
  }
  return new AddonSandbox(manifest.id, options.sandboxUrl, code, () => ({}), {
    perform: (op) => performOperation(op),
    report: (message) => LoaderInsights.showErrorMessage(message, "")
  })
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
function performOperation(op: SandboxOperation): void {
  const row = rowFor(op.href)
  switch (op.name) {
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
}
