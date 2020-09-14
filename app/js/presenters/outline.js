const web_control = require("../web_control")
let story_list_item = require("../view/StoryListItem")

const description = "Presents contents of a webpage in more readable way"
const options = {
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

module.exports = {
  description,
  options,
  present,
  handles,
  is_presenter_url,
  display_url,
  story_elem_button,
  urlbar_button,
  init_in_webtab,
}

//check for more uniq data url
const data_outline_url = "data:text/html;charset=utf-8,"
const outline_api = "https://api.outline.com/v3/parse_article?source_url="

function handles(url) {
  //Hanlde non by default
  return false
}

function is_presenter_url(url) {
  return url.startsWith(data_outline_url) || url.startsWith(outline_api)
}

function outline_button_active() {
  if (document.querySelector("#outline_webview_btn")) {
    outline_webview_btn.classList.add("active")
  }
}

function outline_button_inactive() {
  if (document.querySelector("#outline_webview_btn")) {
    outline_webview_btn.classList.remove("active")
  }
}

function story_elem_button(story, inmain = true) {
  if (!options.story_button.value) {
    return
  }

  let outline_btn = story_list_item.icon_button(
    "outline",
    "outline_btn",
    "imgs/article.svg"
  )
  outline_btn.style.order = "2"

  if (inmain) {
    outline_btn.onclick = (x) => {
      const web_control = require("../web_control")
      web_control.send_or_create("outline", story.href)
    }
  } else {
    outline_btn.onclick = (x) => {
      outline(story.href)
    }
  }

  return outline_btn
}

function init_in_webtab() {
  const { ipcRenderer } = require("electron")
  ipcRenderer.on("outline", (event, href) => {
    outline(href)
  })

  if (!options.urlbar_button.value) {
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

  button.onclick = (x) => {
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

function display_url(url) {
  outline_button_inactive()

  if (url.startsWith(outline_api)) {
    webview.executeJavaScript("(" + outline_jshook.toString() + ")()")
    outline_button_active()
  } else if (url.startsWith(data_outline_url)) {
    outline_button_active()
    if (url.split("#").length > 1) {
      return decodeURIComponent(url.split("#")[1])
    }
  }
}

async function present(url) {
  outline(url)
}

async function outline(url) {
  let urlfield = document.querySelector("#urlfield")
  if (urlfield == undefined) {
    web_control.send_or_create("outline", url)
    return
  }
  urlfield.value = url
  let og_url = url
  let story_content = null

  let content_resp
  if (options.use_webarchive.value) {
    content_resp = await archive_cache(url)
  }
  if (content_resp == undefined || !content_resp.ok) {
    if (options.use_google_cache.value) {
      content_resp = await google_cache(url)
    }
  }
  if (content_resp == undefined || !content_resp.ok) {
    content_resp = await fetch(url)
  }

  if (!content_resp.ok) {
    console.log("failed to get story content", url)
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

  doc.querySelectorAll("a, img").forEach((e) => {
    if (e.hasAttribute("href") && e.getAttribute("href") != e.href) {
      e.setAttribute("href", e.href)
    }
    if (e.hasAttribute("src") && e.getAttribute("src") != e.src) {
      e.setAttribute("src", e.src)
    }
  })

  var article = new Readability(doc).parse()
  if (!article) {
    article = {}
  }
  if (!article.content) {
    article.title = ""
  }
  if (!article.content) {
    article.content = "Readability fail"
  }

  let title = document.createElement("h1")
  title.innerText = article.title
  title.classList.add("outlined")

  webview
    .loadURL(
      data_outline_url +
        encodeURIComponent(base.outerHTML) +
        encodeURIComponent(title.outerHTML) +
        encodeURIComponent(article.content) +
        "#" +
        encodeURIComponent(og_url)
    )
    .catch((e) => {
      console.log("webview.loadURL error", e)
    })
}

async function archive_cache(url) {
  let f = await fetch("https://archive.org/wayback/available?url=" + url)
  let resp = await f.json()
  if (
    resp.hasOwnProperty("archived_snapshots") &&
    resp.archived_snapshots.hasOwnProperty("closest") &&
    resp.archived_snapshots.closest.available
  ) {
    let arch_url = new URL(resp.archived_snapshots.closest.url)
    arch_url.protocol = "https:"
    url = arch_url

    let f2 = await fetch(url)
    return f2
  }
}

async function google_cache(url) {
  let f = await fetch(
    "https://webcache.googleusercontent.com/search?q=cache:" + url
  )
  return f
}

function outline_fallback(url) {
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

function fix_rel(el, base_url) {
  if (el.hasAttribute("src") && el.getAttribute("src") != el.src) {
    if (el.getAttribute("src").startsWith("/")) {
      console.log(el.getAttribute("src"), "!=", el.src, el)
      /*
      console.log("fix_rel", el, el.src, el.protocol)
      el.protocol = base_url.protocol
      el.host = base_url.host
      console.log("fix_rel", el, el.href, el.protocol)  
      */
    }
  }
  if (el.hasAttribute("href") && el.getAttribute("href") != el.href) {
    if (el.getAttribute("href").startsWith("/")) {
      console.log(el.getAttribute("href"), "!=", el.href)
      console.log("fix_rel", el, el.href, el.protocol)
      el.protocol = base_url.protocol
      el.host = base_url.host
      console.log("fix_rel", el, el.href, el.protocol)
    }
  }
}
