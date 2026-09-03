import { OnceClient } from "@once/app"
import {
  AddonManifest,
  AddonRun,
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

/**
 * Turns the `addons` document into live contributions: every enabled
 * manifest's story elements and actions are registered with the row and
 * action registries, and re-registered whenever the document changes. All
 * of it is declarative; nothing here runs add-on code.
 */
export function mountAddons(client: OnceClient): void {
  const release: (() => void)[] = []
  const apply = async (): Promise<void> => {
    for (const fn of release.splice(0)) fn()
    const doc = await client.getAddons()
    for (const entry of doc.addons) {
      if (!entry.enabled) continue
      release.push(...registerManifest(entry.manifest))
    }
    refreshStoryElements()
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

function registerManifest(manifest: AddonManifest): (() => void)[] {
  const releases: (() => void)[] = []
  for (const contribution of manifest.contributions) {
    const id = addonContributionId(manifest.id, contribution.id)
    if (contribution.kind === "action") {
      const applies = (row: StoryListItem) => storyMatchesCondition(contribution.when, viewOf(row))
      const run = (row: StoryListItem) => runAction(manifest, contribution.run, row)
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
    } else {
      releases.push(registerStoryElement(textElement(id, contribution)))
    }
  }
  return releases
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
      const text = renderAddonTemplate(contribution.text, view, "text").trim()
      if (!text) return null
      const element = document.createElement(contribution.kind === "badge" ? "span" : "div")
      element.className = contribution.kind === "badge" ? "addon_badge" : "addon_line"
      element.textContent = text
      return element
    }
  }
}

function runAction(manifest: AddonManifest, run: AddonRun, row: StoryListItem): void {
  const view = viewOf(row)
  try {
    if ("open" in run) {
      const target = run.target === "blank" ? "blank" : run.target === "middle" ? "middle" : "_self"
      row.read_btn.classList.add("user_interaction")
      getOnceClient().openUrl(renderAddonTemplate(run.open, view, "url"), target)
    } else if ("copy" in run) {
      void navigator.clipboard.writeText(renderAddonTemplate(run.copy, view, "text"))
    } else if ("search" in run) {
      searchStories(renderAddonTemplate(run.search, view, "text"))
    } else if ("tag" in run) {
      const tags = row.story.tags ?? []
      if (tags.some((tag) => tag.text === run.tag)) return
      void getOnceClient().persistStoryChange(
        row.story.href, "tags", [...tags, { class: "category", text: run.tag }]
      )
    } else if ("setReadState" in run) {
      const previous = row.story.read_state
      if (previous === run.setReadState) return
      row.read_btn.classList.add("user_interaction")
      StoryHistory.instance?.story_change(row.story, run.setReadState, previous)
      void getOnceClient().persistStoryChange(row.story.href, "read_state", run.setReadState)
    }
  } catch (error) {
    report(`Add-on ${manifest.name} could not run its action`, error)
  }
}
