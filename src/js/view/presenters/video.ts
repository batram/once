import { Story } from "../../data/Story"
import { StoryListItem } from "../StoryListItem"
import { TabWrangler } from "../TabWrangler"
import { ipcRenderer } from "electron"
import * as child_process from "child_process"
import * as path from "path"

const description = "Presents contents of a webpage in more readable way"
const player_html = path.join(__dirname, "video", "player.html")

const presenter_options: Record<
  string,
  { value: boolean | string; description: string }
> = {
  urlbar_button: {
    value: true,
    description: "show video-button in urlbar",
  },
  story_button: {
    value: "handled",
    description: "video-button for story (always | never | handled)",
  },
}

export {
  description,
  presenter_options,
  present,
  handle,
  handle_url,
  is_presenter_url,
  display_url,
  story_elem_button,
  urlbar_button,
  init_in_webtab,
}

//check for more uniq data url
const data_video_url = "data:text/html;charset=utf-8,<!--video-->"
const data_video_url_fail = "data:text/plain;charset=utf-8,video%20failed"

function handle_url(url: string): boolean {
  return (
    url.includes("gfycat.com") ||
    url.startsWith("https://v.redd.it") ||
    url.includes("imgur.") ||
    url.includes("://roosterteeth.com")
  )
}

async function handle(url: string): Promise<boolean> {
  if (handle_url(url)) {
    //TODO: this is way to slow ... extract pattern
    let src: string | { src: string; type?: string } = null
    let title: string = null
    const shortcut_src = shortcut(url)
    if (shortcut_src) {
      src = shortcut_src
      title = "about:blank"
    } else {
      const bat = child_process.spawnSync("youtube-dl", ["--dump-json", url], {
        encoding: "utf8",
      })
      if (bat.status == 0) {
        console.log(typeof bat.stdout, bat.stdout)
        const json_resp = bat.stdout
        const video_info = JSON.parse(json_resp)
        console.debug(video_info)
        src = find_source(video_info)
        title = video_info.title
      }
    }
    if (src) {
      const webview = document.querySelector<Electron.WebviewTag>("#webview")
      const urlfield = document.querySelector<HTMLInputElement>("#urlfield")
      if (!webview || !urlfield) {
        console.error(
          "video failed to find webview and urlfield",
          webview,
          urlfield
        )
        return
      }

      urlfield.value = url
      const set_src = () => {
        video_button_active()
        urlfield.value = url
        webview.executeJavaScript(`
            videojs("#player").src(${JSON.stringify(src)})
            videojs("#player").play()
            document.title = ${JSON.stringify(title)}
          `)
        webview.removeEventListener("dom-ready", set_src)
      }

      webview.addEventListener("dom-ready", set_src)
      webview.loadURL(player_html).catch((e) => {
        console.log("webview.loadURL error", e)
      })
      return true
    }
  }
  return false
}

function shortcut(url: string): string | { src: string; type?: string } {
  if (url.startsWith("https://v.redd.it/")) {
    return {
      src: url + "/HLSPlaylist.m3u8",
    }
  }
}

interface RequestFormat {
  manifest_url?: string
  format_id?: string
  url: string
  protocol: string
}

interface VideoDLInfo {
  ext: string
  format_id: string
  url?: string
  manifest_url?: string
  requested_formats: RequestFormat[]
}

function find_source(
  video_info: VideoDLInfo
): string | { src: string; type?: string } {
  if (video_info.format_id == "mp4" && video_info.url) {
    return video_info.url as string
  } else if (video_info.format_id.includes("dash")) {
    if (video_info.manifest_url) {
      return {
        src: video_info.manifest_url,
        type: "application/dash+xml",
      }
    }

    if (
      video_info.requested_formats &&
      video_info.requested_formats.length != 0 &&
      video_info.requested_formats[0].manifest_url &&
      video_info.requested_formats[0].format_id.includes("dash")
    ) {
      return {
        src: video_info.requested_formats[0].manifest_url,
        type: "application/dash+xml",
      }
    }
    if (
      video_info.requested_formats &&
      video_info.requested_formats.length != 0 &&
      video_info.requested_formats[0].url
    ) {
      return {
        src: video_info.requested_formats[0].url,
      }
    }
  }
}

function is_presenter_url(url: string): boolean {
  console.debug(player_html)
  const will_present =
    url.startsWith(data_video_url) ||
    url.startsWith(data_video_url_fail) ||
    url.startsWith(player_html) ||
    url.includes("js/view/presenters/video/player.html")
  if (will_present) {
    video_button_active()
  } else {
    video_button_inactive()
  }
  return will_present
}

function video_button_active() {
  const button = document.querySelector("#video_webview_btn")
  if (button) {
    button.classList.add("active")
  }
}

function video_button_inactive() {
  const button = document.querySelector("#video_webview_btn")
  if (button) {
    button.classList.remove("active")
  }
}

function story_elem_button(story: Story, intab = false): HTMLElement {
  const video_btn = StoryListItem.icon_button(
    "video-dl",
    "video_btn",
    "imgs/video.svg"
  )
  video_btn.style.order = "2"

  if (!intab) {
    //prevent scroll, but fire interaction only on mouseup
    video_btn.addEventListener("mousedown", (event) => {
      if (event.button == 1) {
        event.preventDefault()
        event.stopPropagation()
        return false
      }
    })

    video_btn.addEventListener("mouseup", (event) => {
      if (event.button == 0) {
        TabWrangler.ops.send_or_create_tab("video", story.href)
      } else if (event.button == 1) {
        event.preventDefault()
        event.stopPropagation()
        TabWrangler.ops.send_to_new_tab("video", story.href)
        return false
      }
      //TODO: show cache options on 2?
    })
  } else {
    video_btn.onclick = () => {
      video_button_active()
      present(story.href)
    }
  }

  return video_btn
}

function init_in_webtab(): void {
  ipcRenderer.on("video", (_event, href) => {
    video_button_active()
    present(href)
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
    "video-dl",
    "video_btn",
    "imgs/video.svg"
  )

  button.id = "video_webview_btn"
  button.classList.add("bar_btn")
  button.style.marginRight = "3px"

  button.onclick = () => {
    const webview = document.querySelector<Electron.WebviewTag>("#webview")
    const urlfield = document.querySelector<HTMLInputElement>("#urlfield")
    if (!webview || !urlfield) {
      console.error(
        "video failed to find webview and urlfield",
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
      present(urlfield.value)
    }
  }

  return button
}

function display_url(url: string): string {
  video_button_inactive()

  if (is_presenter_url(url)) {
    video_button_active()
    if (url.split("#").length > 1) {
      return decodeURIComponent(url.split("#")[1])
    }
  }
}

async function present(url: string): Promise<void> {
  console.log(url)
  fail_video("not implemented")
}

function fail_video(reason: string) {
  const webview = document.querySelector<Electron.WebviewTag>("#webview")
  webview
    .loadURL(
      data_video_url_fail +
        encodeURIComponent("  " + reason) +
        "#" +
        "video:failed"
    )
    .catch((e) => {
      console.error("webview.loadURL error", e)
    })
}
