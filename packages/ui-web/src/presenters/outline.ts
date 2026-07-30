import { Story } from "@once/core"
import { createIconButton } from "../story/storyRowMarkup"
//import * as Readability from "../../third_party/Readability.js"
import { PresenterOptions } from "./registry"
import { getOnceClient } from "../client"
import { ReaderView } from "../reader/ReaderView"
import { LoaderInsights } from "../shell/LoaderInsights"
import { requireElement } from "../dom"

export const presenter_options: PresenterOptions = {
  story_button: {
    value: "always",
    description: "show outline-button for story (always | never | handled)"
  }
}

export function handle_url(_: string): boolean {
  return false
}

export function story_elem_button(story: Story): HTMLElement {
  const outline_btn = createIconButton(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )
  outline_btn.dataset.testid = "story-reader"
  outline_btn.classList.add("outline_button")

  if (story.has_content()) {
    const img = requireElement<HTMLImageElement>("img", outline_btn)
    img.src = "imgs/stored_content.svg"
  }

  //prevent scroll, but fire interaction only on mouseup
  outline_btn.addEventListener("mousedown", (event) => {
    if (event.button == 1) {
      event.preventDefault()
      event.stopPropagation()
      return false
    }
  })

  outline_btn.addEventListener("mouseup", async (e: MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return

    try {
      if (e.button === 1) {
        // Middle click
        e.preventDefault()
        e.stopPropagation()
        await openInReaderMode(story.href, true)
      } else if (e.button === 0) {
        // Left click
        await openInReaderMode(story.href, false)
      }

      outline_btn.parentElement
        ?.querySelector(".read_btn")
        ?.classList.add("user_interaction")
      await getOnceClient().persistStoryChange(
        story.href,
        "read_state",
        "read"
      )
    } catch (error) {
      showReaderError(error, story.href)
    }
  })

  return outline_btn
}

async function openInReaderMode(url: string, newTab = false) {
  if (newTab) {
    await ReaderView.open(url, "middle")
    return
  }
  await ReaderView.open(url)
}

function showReaderError(error: unknown, url: string): void {
  const detail = error instanceof Error ? error.message : String(error)
  console.error("Reader mode failed", error)
  LoaderInsights.showErrorMessage(
    `Reader mode failed: ${detail}`,
    `Operation: reader.open\nStory: ${url}\n\n${
      error instanceof Error ? error.stack || error.message : String(error)
    }`
  )
}
