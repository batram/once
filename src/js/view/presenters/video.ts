import { Story } from "../../data/Story"
import { StoryListItem } from "../StoryListItem"
import { TabWrangler } from "../TabWrangler"
import { ipcRenderer, WebviewTag } from "electron"
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
    url.includes("://roosterteeth.com") ||
    (url.includes("youtu") &&
      url.match(/[/=:]+([0-9A-Za-z_-]{11})/).length != 0)
  )
}

async function handle(url: string): Promise<boolean> {
  if (handle_url(url)) {
    return present(url)
  }
  return false
}

async function shortcut(
  url: string
): Promise<{ src: string; type?: string; title?: string }> {
  if (url.startsWith("https://v.redd.it/")) {
    return {
      src: url + "/DASHPlaylist.mpd",
      type: "application/dash+xml",
    }
  } else if (url.includes("youtu") && url.match(/[/=:]+([0-9A-Za-z_-]{11})/)) {
    const id = url.match(/[/=:]+([0-9A-Za-z_-]{11})/)[1]
    return source_youtube(id, url)
  }
}

interface RequestFormat {
  manifest_url?: string
  format_id?: string
  url: string
  protocol: string
}

interface VideoFormat {
  asr?: number
  abr?: number
  acodec?: string
  downloader_options: { http_chunk_size: number }
  ext: string
  filesize: number
  format: string
  format_id: string
  format_note: string
  fps: number
  height: number
  http_headers?: Record<string, string>
  player_url: string
  protocol: string
  tbr: number
  url: string
  vcodec: string
  width: number
}

interface VideoDLInfo {
  ext: string
  format_id: string
  url?: string
  manifest_url?: string
  requested_formats: RequestFormat[]
  formats?: VideoFormat[]
  duration?: number
  extractor?: string
  title: string
}

function find_source(video_info: VideoDLInfo): { src: string; type?: string } {
  if (video_info.format_id == "mp4" && video_info.url) {
    return { src: video_info.url }
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
    video_btn.onclick = async () => {
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

async function video_dl(url: string): Promise<VideoDLInfo> {
  const bat = child_process.spawnSync("youtube-dl", ["--dump-json", url], {
    encoding: "utf8",
  })
  if (bat.status == 0) {
    const json_resp = bat.stdout
    const video_info = JSON.parse(json_resp)
    return video_info
  }
}

async function present(url: string): Promise<boolean> {
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
  //TODO: this is way to slow ... extract pattern
  let src: { src: string; type?: string; title?: string } = null
  let title: string = null
  const shortcut_src = await shortcut(url)
  if (shortcut_src) {
    src = shortcut_src
    if (src.title) {
      title = src.title
    } else {
      title = "about:blank"
    }
  } else {
    const video_info = await video_dl(url)
    if (video_info) {
      src = find_source(video_info)
      title = video_info.title
    }
  }
  if (src) {
    urlfield.value = url

    const set_src = () => {
      video_button_active()
      urlfield.value = url
      webview.executeJavaScript(`
            videojs("#player").src(${JSON.stringify(src)})
            videojs("#player").play()
            document.title = ${JSON.stringify(title)}
          `)
      try {
        const parsed_url = new URL(url)
        const params = parsed_url.searchParams
        if (params.has("t")) {
          webview.executeJavaScript(`
              videojs("#player").currentTime(${parseInt(params.get("t"))})
            `)
        }
      } catch (e) {
        console.error("time url parsing failed", e)
      }
      webview.removeEventListener("dom-ready", set_src)
    }

    webview.addEventListener("dom-ready", set_src)
    webview.loadURL(player_html).catch((e) => {
      console.log("webview.loadURL error", e)
    })
    return true
  }
}

async function source_youtube(
  id: string,
  url: string
): Promise<{ src: string; type?: string; title?: string }> {
  const resp = await fetch("https://www.youtube.com/watch?v=" + id)
  if (resp.ok) {
    const text = await resp.text()
    const dp = new DOMParser()
    const ydoc = dp.parseFromString(text, "text/html")

    const scriptle = Array.from(
      ydoc.querySelectorAll<HTMLElement>("#player-wrap script")
    ).filter((script) => script.innerText.includes("ytplayer.config = "))
    if (scriptle.length != 0) {
      const title = ydoc.querySelector("title").innerText

      const yt_config_raw = scriptle[0].innerText.split("ytplayer.config = ")[1]

      let yt_config: {
        assets: { js?: string }
        args?: { player_response?: string }
      }

      try {
        yt_config = JSON.parse(yt_config_raw)
      } catch (e) {
        const numnum = e.toString().match(/; in JSON at position (\d+)/)
        if (numnum) {
          yt_config = JSON.parse(yt_config_raw.substring(0, numnum[1]))
          console.log(yt_config)
        }
      }

      if (yt_config) {
        try {
          const player_response: PlayerResponse = JSON.parse(
            yt_config.args.player_response
          )
          if (player_response.streamingData.dashManifestUrl) {
            return {
              src: player_response.streamingData.dashManifestUrl,
              type: "application/dash+xml",
              title: title,
            }
          }
          if (
            player_response.streamingData.adaptiveFormats[0].signatureCipher
          ) {
            let base_js = null
            if (yt_config.assets && yt_config.assets.js) {
              base_js = yt_config.assets.js
            } else {
              if (ydoc.querySelector("script[src*='base.js']")) {
                base_js = ydoc
                  .querySelector("script[src*='base.js']")
                  .getAttribute("src")
              }
            }
            if (base_js) {
              const base_req = await fetch("https://www.youtube.com" + base_js)
              if (base_req.ok) {
                const base_src = await base_req.text()
                const func = base_src.match(
                  /^[^=]+(?<fungy>=function\(\w\){\w=\w\.split\(""\);[^. ]+\.[^( ]+[^}]+})/m
                )
                const k = func[0].split(";")[1].split(".")[0]
                const var_body = base_src
                  .replace(/\n/g, "")
                  .match(new RegExp(`var ${k}={.*?};`))[0]
                const fungy_code =
                  var_body + "\n" + "var fungy" + func.groups.fungy
                const webview = document.querySelector<WebviewTag>("webview")

                for (const format of player_response.streamingData
                  .adaptiveFormats) {
                  const ul = new URLSearchParams(format.signatureCipher)
                  const defunged = await webview.executeJavaScript(
                    fungy_code + "\n" + `fungy(atob("${btoa(ul.get("s"))}"))`
                  )
                  format.url =
                    ul.get("url") + "&" + ul.get("sp") + "=" + defunged
                }
              }
            } else {
              const info = await video_dl(url)
              console.debug("video_dl", info)
              const deciphered: Record<string, string> = {}

              info.formats.forEach((x) => {
                deciphered[x.format_id] = x.url
              })

              player_response.streamingData.adaptiveFormats.forEach(
                (format) => {
                  format.url = deciphered[format.itag]
                }
              )
            }
          }

          const dash_src = await youtube_dash(player_response)
          if (title) {
            dash_src.title = title
          }
          return dash_src
        } catch (e) {
          console.error("yt ", e)
        }
      }
    }
  }
}

declare interface PlayerResponse {
  videoDetails?: {
    lengthSeconds?: number
  }
  streamingData?: {
    dashManifestUrl?: string
    adaptiveFormats?: {
      approxDurationMs?: string
      averageBitrate?: number
      bitrate: number
      contentLength: string
      fps: number
      height?: number
      indexRange: { start: string; end: string }
      initRange: { start: string; end: string }
      itag: number
      lastModified: string
      mimeType: string
      projectionType: string
      quality: string
      qualityLabel: string
      url?: string
      signatureCipher?: string
      width?: number
    }[]
  }
}

async function youtube_dash(
  response: PlayerResponse
): Promise<{ src: string; type?: string; title?: string }> {
  const chosen_formats = ["136", "137", "135", "133", "140", "160"]
  const xmlDoc = document.implementation.createDocument(
    "urn:mpeg:dash:schema:mpd:2011",
    "MPD",
    null
  )
  const mpd_base = xmlDoc.firstElementChild
  mpd_base.setAttribute(
    "mediaPresentationDuration",
    `PT${response.videoDetails.lengthSeconds}S`
  )
  mpd_base.setAttribute("profiles", "urn:mpeg:dash:profile:full:2011")
  mpd_base.setAttribute("minBufferTime", "PT0.2S")
  mpd_base.setAttribute("type", "static")

  const period = xmlDoc.createElement("Period")
  mpd_base.append(period)

  let n = 0

  response.streamingData.adaptiveFormats.forEach((format) => {
    if (chosen_formats.includes(format.itag.toString())) {
      const mime_codec = format.mimeType.split("; ")
      const mimeType = mime_codec[0]
      const codec = mime_codec[1].split('"')[1]

      const adaptationSet = xmlDoc.createElement("AdaptationSet")
      adaptationSet.id = n.toString()
      n += 1
      adaptationSet.setAttribute("mimeType", mimeType)

      const representation = xmlDoc.createElement("Representation")
      representation.id = format.itag.toString()
      representation.setAttribute("codecs", codec)
      if (format.height) {
        representation.setAttribute("height", format.height.toString())
      }
      if (format.bitrate) {
        representation.setAttribute("bandwidth", format.bitrate.toString())
      }

      //codecs="avc1.640028" height="1080"  bandwidth="4403702"
      adaptationSet.append(representation)
      const baseURL = xmlDoc.createElement("BaseURL")
      baseURL.textContent = format.url
      representation.append(baseURL)

      const segmentBase = xmlDoc.createElement("SegmentBase")
      segmentBase.setAttribute(
        "indexRange",
        `${format.indexRange.start}-${format.indexRange.end}`
      )
      representation.append(segmentBase)

      const initialization = xmlDoc.createElement("Initialization")
      initialization.setAttribute(
        "range",
        `${format.initRange.start}-${format.initRange.end}`
      )
      segmentBase.append(initialization)

      period.append(adaptationSet)
    }
  })

  let data_url = "data:application/dash+xml;base64,"

  data_url += btoa(
    '<?xml version="1.0" encoding="UTF-8"?>' + mpd_base.outerHTML
  )

  return { src: data_url, type: "application/dash+xml" }
}
