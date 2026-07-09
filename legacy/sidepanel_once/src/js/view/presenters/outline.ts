import { Story } from "../../data/Story"
import { StoryListItem } from "../../view/StoryListItem"
import * as Readability from "../../third_party/Readability.js"
import { StoryMap } from "../../data/StoryMap"

export const description = "Presents contents of a webpage in more readable way"

export const presenter_options: Record<
  string,
  { value: boolean | string; description: string }
> = {
  urlbar_button: {
    value: true,
    description: "show outline-button in urlbar",
  },
  story_button: {
    value: "always",
    description: "show outline-button for story (always | never | handled)",
  },
  use_google_cache: {
    value: false,
    description: "Try to get the content from google cache",
  },
  use_webarchive: {
    value: true,
    description: "Try to get the content from webarchive",
  },
}

//check for more uniq data url
const data_outline_url = "data:text/html;charset=utf-8,<!--outline-->"
const outline_proto = "outline://data"
const data_outline_url_fail = "data:text/plain;charset=utf-8,outline%20failed"

//let current_tab: WebTab

export function handle_url(): boolean {
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

  outline_btn.addEventListener("mouseup", async (event) => {
    outline_btn.parentElement
      .querySelector(".read_btn")
      .classList.add("user_interaction")

    if (event.button == 0) {
      //TabWrangler.ops.send_or_create_tab("outline", story.href)
    } else if (event.button == 1) {
      event.preventDefault()
      event.stopPropagation()
      //TabWrangler.ops.send_to_new_tab("outline", story.href)
      return false
    }
    //TODO: show cache options on 2?
  })

  return outline_btn
}

export function init_in_webtab(): void {
  //current_tab = tab
  /*  BackComms.on("outline", (_event, href) => {
    outline_button_active()
    outline(href)
  })*/

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
  /* const webview = document.querySelector<Electron.WebviewTag>("#webview")
  let story_content = null

  const story = await StoryMap.remote.get(url)
  if (story) {
    story_content = await story.get_content()
  }

  if (!story_content) {
    if (BackComms.sendSync("has_outlined", url)) {
      //webview.setAttribute("src", "outline://data:" + encodeURIComponent(url))
      return
    } else {
      if (webview.getAttribute("src") == url) {
        //already have the url loaded, get the document
        story_content = await webview.executeJavaScript(
          "document.documentElement.outerHTML"
        )
    }
    }
  }

  try {
    webview.setAttribute(
      "src",
      data_outline_url +
        "<title>outlining</title>started outlining" +
        "#" +
        encodeURIComponent(url)
    )
  } catch (e) {
    console.log("meop")
  }

  if (!webview) {
    fail_outline("failed to find webview")
    return
  }

  const urlfield = document.querySelector<HTMLInputElement>("#urlfield")
  if (urlfield == undefined) {
    TabWrangler.ops.send_or_create_tab("outline", url)
    return
  }
  //current_tab.set_url(url)
  const og_url = url

  if (!story_content) {
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

  doc.querySelectorAll<HTMLImageElement>("iframe").forEach((e) => {
    if (e.hasAttribute("src")) {
      const src = e.getAttribute("src")
      if (
        src.startsWith("https://web.archive.org/web/") &&
        src.includes("if_/") &&
        (src.includes("youtube.com") || src.includes("youtu.be"))
      ) {
        e.src = src.split("if_/")[1]
      }
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

  if (!article.title && story && story.title) {
    article.title = story.title
  }

  const h1_title = document.createElement("h1")
  h1_title.innerText = article.title
  h1_title.classList.add("outlined")

  const title = document.createElement("title")
  title.innerText = article.title

  const data =
    '<link rel="stylesheet" href="outline://css">' +
    base.outerHTML +
    title.outerHTML +
    h1_title.outerHTML +
    article.content

  BackComms.sendSync("outlined", og_url, data)

  webview.setAttribute("src", "outline://data:" + encodeURIComponent(og_url))
  */
}

function fail_outline(reason: string) {
  /*const webview = document.querySelector<Electron.WebviewTag>("#webview")
  webview.setAttribute(
    "src",
    data_outline_url_fail +
      encodeURIComponent("  " + reason) +
      "#" +
      "outline:failed"
  )*/
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
