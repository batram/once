import { Story } from "../../data/Story"
import * as story_list_item from "../../view/StoryListItem"
import * as Readability from "../../third_party/Readability.js"
import * as web_control from "../../web_control"
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
const outline_api = "https://api.outline.com/v3/parse_article?source_url="

function handles(url: string) {
  //Handle non by default
  return false
}

function is_presenter_url(url: string) {
  let will_present =
    url.startsWith(data_outline_url) || url.startsWith(outline_api)
  if (will_present) {
    outline_button_active()
  } else {
    outline_button_inactive()
  }
  return will_present
}

function outline_button_active() {
  let button = document.querySelector("#outline_webview_btn")
  if (button) {
    button.classList.add("active")
  }
}

function outline_button_inactive() {
  let button = document.querySelector("#outline_webview_btn")
  if (button) {
    button.classList.remove("active")
  }
}

function story_elem_button(story: Story, inmain = true) {
  if (!presenter_options.story_button.value) {
    return
  }

  let outline_btn = story_list_item.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )
  outline_btn.style.order = "2"

  if (inmain) {
    outline_btn.onclick = () => {
      web_control.send_or_create_tab("outline", story.href)
    }
  } else {
    outline_btn.onclick = () => {
      outline_button_active()
      outline(story.href)
    }
  }

  return outline_btn
}

function init_in_webtab() {
  ipcRenderer.on("outline", (event, href) => {
    outline_button_active()
    outline(href)
  })

  if (!presenter_options.urlbar_button.value) {
    return
  }

  let controlbar = document.querySelector("#controlbar")
  if (controlbar) {
    controlbar.insertBefore(urlbar_button(), controlbar.firstChild)
  }
}

function urlbar_button() {
  let button = story_list_item.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )

  button.id = "outline_webview_btn"
  button.classList.add("bar_btn")
  button.style.marginRight = "3px"

  button.onclick = () => {
    let webview = document.querySelector<Electron.WebviewTag>("#webview")
    let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
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

function display_url(url: string) {
  outline_button_inactive()

  if (url.startsWith(outline_api)) {
    let webview = document.querySelector<Electron.WebviewTag>("#webview")
    if (webview) {
      webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
    } else {
      console.error("outline failed to find webview")
    }
    outline_button_active()
  } else if (url.startsWith(data_outline_url)) {
    outline_button_active()
    if (url.split("#").length > 1) {
      return decodeURIComponent(url.split("#")[1])
    }
  }
}

async function present(url: string) {
  outline(url)
}

async function outline(url: string) {
  let webview = document.querySelector<Electron.WebviewTag>("#webview")
  if (!webview) {
    console.error("outline failed to find webview")
    return
  }

  let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
  if (urlfield == undefined) {
    web_control.send_or_create_tab("outline", url)
    return
  }
  urlfield.value = url
  let og_url = url
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
    story_content = "<h1>failed to get story content</h1>"
  } else {
    url = content_resp.url
    story_content = await content_resp.text()
  }

  let dom_parser = new DOMParser()
  let doc = dom_parser.parseFromString(story_content, "text/html")

  let base = document.createElement("base")
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

  var article = new Readability(doc, {}).parse()
  if (!article) {
    webview
      .loadURL(
        data_outline_url +
          encodeURIComponent("outline failed") +
          "#" +
          "outline:failed"
      )
      .catch((e) => {
        console.log("webview.loadURL error", e)
      })
    return
  }
  if (!article.content) {
    article.title = ""
  }
  if (!article.content) {
    article.content = "Readability fail"
  }

  let h1_title = document.createElement("h1")
  h1_title.innerText = article.title
  h1_title.classList.add("outlined")

  let title = document.createElement("title")
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

async function archive_cache(url: string) {
  let f = await fetch("https://archive.org/wayback/available?url=" + url)
  let resp = await f.json()
  if (
    resp.hasOwnProperty("archived_snapshots") &&
    resp.archived_snapshots.hasOwnProperty("closest") &&
    resp.archived_snapshots.closest.available
  ) {
    let arch_url = new URL(resp.archived_snapshots.closest.url)
    arch_url.protocol = "https:"
    url = arch_url.toString()

    let f2 = await fetch(url)
    return f2
  }
}

async function google_cache(url: string) {
  let f = await fetch(
    "https://webcache.googleusercontent.com/search?q=cache:" + url
  )
  return f
}

function outline_fallback(url: string) {
  let webview = document.querySelector<Electron.WebviewTag>("#webview")
  let urlfield = document.querySelector<HTMLInputElement>("#urlfield")
  if (!webview || !urlfield) {
    console.error(
      "outline failed to find webview or urlfield",
      webview,
      urlfield
    )
    return
  }

  urlfield.value = url
  let options = {
    httpReferrer: "https://outline.com/",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.125 Safari/537.36",
  }
  webview.loadURL(outline_api + escape(url), options).catch((e) => {
    console.log("webview.loadURL error", e)
  })
}

function outline_jshook() {
  let data = JSON.parse(document.body.innerText).data
  let title = document.createElement("h1")
  title.innerText = data.title
  document.body.innerHTML = title.outerHTML
  document.body.innerHTML += data.html
}