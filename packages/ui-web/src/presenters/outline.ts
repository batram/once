import { Story } from "@once/core"
import { StoryListItem } from "../StoryListItem"
//import * as Readability from "../../third_party/Readability.js"
import { Presenter, PresenterOptions } from "../presenters_frontend"
import { getOnceClient } from "../client"

export const description = "Presents contents of a webpage in more readable way"

export const presenter_options: PresenterOptions = {
  urlbar_button: {
    value: true,
    description: "show outline-button in urlbar"
  },
  story_button: {
    value: "always",
    description: "show outline-button for story (always | never | handled)"
  },
  use_google_cache: {
    value: false,
    description: "Try to get the content from google cache"
  },
  use_webarchive: {
    value: true,
    description: "Try to get the content from webarchive"
  }
}

//check for more uniq data url
const data_outline_url = "about:reader?url="
const outline_proto = "outline://data"
const data_outline_url_fail = "data:text/plain;charset=utf-8,outline%20failed"

//let current_tab: WebTab

export async function handle_url(_: string): Promise<boolean> {
  return false
}

export async function handle(): Promise<boolean> {
  //Handle non by default
  return false
}

export function is_presenter_url(url: string): boolean {
  const will_present =
    url.startsWith(data_outline_url) ||
    url.startsWith(data_outline_url_fail) ||
    url.startsWith(outline_proto)
  if (will_present) {
    outline_button_active()
  } else {
    outline_button_inactive()
  }
  return will_present
}

function outline_button_active() {
  const button = document.querySelector("#outline_webview_btn")
  if (button) {
    button.classList.add("active")
  }
}

function outline_button_inactive() {
  const button = document.querySelector("#outline_webview_btn")
  if (button) {
    button.classList.remove("active")
  }
}

export function story_elem_button(story: Story): HTMLElement {
  const outline_btn = StoryListItem.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )
  outline_btn.style.order = "2"

  if (story.has_content()) {
    outline_btn.querySelector("img").src = "imgs/stored_content.svg"
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
    if (e.button === 2) return

    outline_btn.parentElement
      ?.querySelector(".read_btn")
      ?.classList.add("user_interaction")
    await getOnceClient().persistStoryChange(
      story.href,
      "read_state",
      "read"
    )

    // Use the helper function instead of encodeToReaderModeUrl
    if (e.button === 1) {
      // Middle click
      e.preventDefault()
      e.stopPropagation()
      openInReaderMode(story.href, true)
    } else if (e.button === 0) {
      // Left click
      openInReaderMode(story.href, false)
    }
  })

  return outline_btn
}

async function openInReaderMode(url: string, newTab = false) {
  getOnceClient().openUrl(url, newTab ? "blank" : "_self")
}

async function openInCurrentTab(url: string) {
  getOnceClient().openUrl(url, "_self")
}

function openInNewTab(url: string) {
  getOnceClient().openUrl(url, "blank")
}

export function init_in_webtab(): void {
  if (!presenter_options.urlbar_button.value) {
    return
  }

  const controlbar = document.querySelector("#controlbar")
  if (controlbar) {
    controlbar.insertBefore(urlbar_button(), controlbar.firstChild)
  }
}

export function urlbar_button(): HTMLElement {
  const button = StoryListItem.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )

  button.id = "outline_webview_btn"
  button.classList.add("bar_btn")
  button.style.marginRight = "3px"

  button.onclick = async () => {
    /*const webview = document.querySelector<Electron.WebviewTag>("#webview")
    const urlfield = document.querySelector<HTMLInputElement>("#urlfield")
    if (!webview || !urlfield) {
      console.error(
        "outline failed to find webview and urlfield",
        webview,
        urlfield
      )
      return
    }
    //TODO: track state in a different way
    if (button.classList.contains("active")) {
      webview.setAttribute("src", urlfield.value)
    } else {
      outline(urlfield.value)
    }*/
  }

  return button
}

export function display_url(url: string): string {
  outline_button_inactive()

  if (
    url.startsWith(data_outline_url) ||
    url.startsWith(data_outline_url_fail) ||
    url.startsWith(outline_proto)
  ) {
    outline_button_active()
    if (url.split("outline://data:").length > 1) {
      return decodeURIComponent(url.split("outline://data:")[1])
    } else if (url.split("#").length > 1) {
      return decodeURIComponent(url.split("#")[1])
    }
  }
}

export async function present(url: string): Promise<void> {
  outline(url)
}

async function outline(url: string): Promise<void> {
  console.debug("outline presenter is not implemented for this surface", url)
}

function fail_outline(reason: string) {
  console.error("outline failed", reason)
}

async function archive_cache(url: string) {
  const f = await fetch("https://archive.org/wayback/available?url=" + url)
  const resp = await f.json()
  if (
    resp.archived_snapshots &&
    resp.archived_snapshots.closest &&
    resp.archived_snapshots.closest.available
  ) {
    const arch_url = new URL(resp.archived_snapshots.closest.url)
    arch_url.protocol = "https:"
    url = arch_url.toString()

    const f2 = await fetch(url)
    return f2
  }
}

async function google_cache(url: string) {
  try {
    const f = await fetch(
      "https://webcache.googleusercontent.com/search?q=cache:" + url
    )
    return f
  } catch (e) {
    console.error("fetch", e)
  }
  return null
}

function encodeToReaderModeUrl(originalUrl: string): string {
  const encodedUrl = encodeURIComponent(originalUrl)
  return `about:reader?url=${encodedUrl}`
}
