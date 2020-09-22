import { Story } from "../../data/Story"
import { StoryListItem } from "../../view/StoryListItem"
import * as Readability from "../../third_party/Readability.js"
import { TabWrangler } from "../../view/TabWrangler"
import { ipcRenderer } from "electron"

const description = "Presents contents of a webpage in more readable way"

const presenter_options: Record<
  string,
  { value: boolean | string; description: string }
> = {
  urlbar_button: {
    value: true,
    description: "show outline-button in urlbar",
  },
  story_button: {
    value: true,
    description: "show outline-button for each story",
  },
  use_google_cache: {
    value: true,
    description: "Try to get the content from google cache",
  },
  use_webarchive: {
    value: true,
    description: "Try to get the content from webarchive",
  },
}

export {
  description,
  presenter_options,
  present,
  handles,
  is_presenter_url,
  display_url,
  story_elem_button,
  urlbar_button,
  init_in_webtab,
}

//check for more uniq data url
const data_outline_url = "data:text/html;charset=utf-8,<!--outline-->"
const data_outline_url_fail = "data:text/plain;charset=utf-8,outline%20failed"

function handles(): boolean {
  //Handle non by default
  return false
}

function is_presenter_url(url: string): boolean {
  const will_present =
    url.startsWith(data_outline_url) || url.startsWith(data_outline_url_fail)
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

function story_elem_button(story: Story, intab = false): HTMLElement {
  if (!presenter_options.story_button.value) {
    return
  }

  const outline_btn = StoryListItem.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )
  outline_btn.style.order = "2"

  if (!intab) {
    //prevent scroll, but fire interaction only on mouseup
    outline_btn.addEventListener("mousedown", (event) => {
      if (event.button == 1) {
        event.preventDefault()
        event.stopPropagation()
        return false
      }
    })

    outline_btn.addEventListener("mouseup", (event) => {
      if (event.button == 0) {
        TabWrangler.ops.send_or_create_tab("outline", story.href)
      } else if (event.button == 1) {
        event.preventDefault()
        event.stopPropagation()
        TabWrangler.ops.send_to_new_tab("outline", story.href)
        return false
      }
      //TODO: show cache options on 2?
    })
  } else {
    outline_btn.onclick = () => {
      outline_button_active()
      outline(story.href)
    }
  }

  return outline_btn
}

function init_in_webtab(): void {
  ipcRenderer.on("outline", (_event, href) => {
    outline_button_active()
    outline(href)
  })

  if (!presenter_options.urlbar_button.value) {
    return
  }

  const controlbar = document.querySelector("#controlbar")
  if (controlbar) {
    controlbar.insertBefore(urlbar_button(), controlbar.firstChild)
  }
}

function urlbar_button(): HTMLElement {
  const button = StoryListItem.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )

  button.id = "outline_webview_btn"
  button.classList.add("bar_btn")
  button.style.marginRight = "3px"

  button.onclick = () => {
    const webview = document.querySelector<Electron.WebviewTag>("#webview")
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
      webview.loadURL(urlfield.value).catch((e) => {
        console.log("webview.loadURL error", e)
      })
    } else {
      outline(urlfield.value)
    }
  }

  return button
}

function display_url(url: string): string {
  outline_button_inactive()

  if (
    url.startsWith(data_outline_url) ||
    url.startsWith(data_outline_url_fail)
  ) {
    outline_button_active()
    if (url.split("#").length > 1) {
      return decodeURIComponent(url.split("#")[1])
    }
  }
}

async function present(url: string): Promise<void> {
  outline(url)
}

async function outline(url: string): Promise<void> {
  const webview = document.querySelector<Electron.WebviewTag>("#webview")
  if (!webview) {
    fail_outline("failed to find webview")
    return
  }

  const urlfield = document.querySelector<HTMLInputElement>("#urlfield")
  if (urlfield == undefined) {
    TabWrangler.ops.send_or_create_tab("outline", url)
    return
  }
  urlfield.value = url
  const og_url = url
  let story_content = null

  let content_resp
  if (presenter_options.use_webarchive.value) {
    content_resp = await archive_cache(url)
  }
  if (content_resp == undefined || !content_resp.ok) {
    if (presenter_options.use_google_cache.value) {
      content_resp = await google_cache(url)
    }
  }
  if (content_resp == undefined || !content_resp.ok) {
    content_resp = await fetch(url)
  }

  if (!content_resp.ok) {
    console.error("outline failed to get story content", url)
    fail_outline("failed to fetch story content")
    return
  } else {
    url = content_resp.url
    const content_type = content_resp.headers.get("content-type")
    if (!content_type.startsWith("text/html")) {
      fail_outline("can not handle content type" + content_resp)
      return
    }
    story_content = await content_resp.text()
  }

  const dom_parser = new DOMParser()
  const doc = dom_parser.parseFromString(story_content, "text/html")

  const base = document.createElement("base")
  base.setAttribute("href", url)

  if (
    doc.querySelector("base") &&
    doc.querySelector("base").hasAttribute("href")
  ) {
    console.log("base already there", doc.querySelector("base"))
  } else {
    doc.head.append(base)
  }

  doc.querySelectorAll<HTMLImageElement>("img").forEach((e) => {
    if (e.hasAttribute("src") && e.getAttribute("src") != e.src) {
      e.setAttribute("src", e.src)
    }
  })

  doc.querySelectorAll<HTMLLinkElement>("a").forEach((e) => {
    if (e.hasAttribute("href") && e.getAttribute("href") != e.href) {
      e.setAttribute("href", e.href)
    }
  })

  const article = new Readability(doc, {}).parse()
  if (!article) {
    fail_outline("Readability didn't find anything")
    return
  }
  if (!article.content) {
    article.title = ""
  }
  if (!article.content) {
    article.content = "Readability fail"
  }

  const h1_title = document.createElement("h1")
  h1_title.innerText = article.title
  h1_title.classList.add("outlined")

  const title = document.createElement("title")
  title.innerText = article.title

  webview
    .loadURL(
      data_outline_url +
        encodeURIComponent(base.outerHTML) +
        encodeURIComponent(title.outerHTML) +
        encodeURIComponent(h1_title.outerHTML) +
        encodeURIComponent(article.content) +
        "#" +
        encodeURIComponent(og_url)
    )
    .catch((e) => {
      console.log("webview.loadURL error", e)
    })
}

function fail_outline(reason: string) {
  const webview = document.querySelector<Electron.WebviewTag>("#webview")
  webview
    .loadURL(
      data_outline_url_fail +
        encodeURIComponent("  " + reason) +
        "#" +
        "outline:failed"
    )
    .catch((e) => {
      console.error("webview.loadURL error", e)
    })
}

async function archive_cache(url: string) {
  const f = await fetch("https://archive.org/wayback/available?url=" + url)
  const resp = await f.json()
  if (
    Object.prototype.hasOwnProperty.call(resp, "archived_snapshots") &&
    Object.prototype.hasOwnProperty.call(resp, "closest") &&
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
  const f = await fetch(
    "https://webcache.googleusercontent.com/search?q=cache:" + url
  )
  return f
}
