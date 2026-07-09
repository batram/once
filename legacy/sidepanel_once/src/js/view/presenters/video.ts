import { Story } from "../../data/Story"
import { StoryListItem } from "../StoryListItem"
import * as child_process from "child_process"
import * as path from "path"
//import { WebTab } from "../WebTab"

export const description = "Presents contents of a webpage in more readable way"
const player_html_path =
  "file://" + path.join(__dirname, "video", "player.html")
//let current_tab: WebTab

export const presenter_options: Record<
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

//check for more uniq data url
const data_video_url = "data:text/html;charset=utf-8,<!--video-->"
const data_video_url_fail = "data:text/plain;charset=utf-8,video%20failed"

export function handle_url(url: string): boolean {
  const parsed_url = new URL(url)
  const host = parsed_url.hostname
  return (
    host &&
    (host.includes("gfycat.com") ||
      host.startsWith("v.redd.it") ||
      host.includes("imgur.") ||
      host.includes("roosterteeth.com") ||
      (host.includes("youtu") && /[/=:]+([0-9A-Za-z_-]{11})/.test(url)))
  )
}

export async function handle(url: string): Promise<boolean> {
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

export function is_presenter_url(url: string): boolean {
  console.debug(player_html_path)
  const will_present =
    url.startsWith(data_video_url) ||
    url.startsWith(data_video_url_fail) ||
    url.startsWith(player_html_path) ||
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

export function story_elem_button(story: Story, intab = false): HTMLElement {
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
        //TabWrangler.ops.send_or_create_tab("video", story.href)
      } else if (event.button == 1) {
        event.preventDefault()
        event.stopPropagation()
        //TabWrangler.ops.send_to_new_tab("video", story.href)
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

export function init_in_webtab(): void {
  //current_tab = tab
  /*
  BackComms.on("video", (_event, href) => {
    video_button_active()
    present(href)
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
    "video-dl",
    "video_btn",
    "imgs/video.svg"
  )

  button.id = "video_webview_btn"
  button.classList.add("bar_btn")
  button.style.marginRight = "3px"

  button.onclick = () => {
    alert(/moin/)
    /*const webview = document.querySelector<Electron.WebviewTag>("#webview")
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
      webview.setAttribute("src", urlfield.value)
    } else {
      present(urlfield.value)
    }*/
  }

  return button
}

export function display_url(url: string): string {
  video_button_inactive()

  if (is_presenter_url(url)) {
    video_button_active()
    if (url.split("#vidinfo_").length > 1) {
      const b64_split = atob(url.split("#vidinfo_")[1])
      const vid_info = JSON.parse(b64_split)
      return vid_info.url
    }
  }
}

async function video_dl(url: string): Promise<VideoDLInfo> {
  const ydl = child_process.spawn("youtube-dl", ["--dump-json", url])
  for await (const json_resp of ydl.stdout) {
    return JSON.parse(json_resp)
  }
}

export async function present(url: string): Promise<boolean> {
  let src: { src: string; type?: string; title?: string } = null
  let title: string = null
  /*
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
  const extracting_info =
    data_video_url +
    "<title>Video: getting info</title> Please wait while we get the video source for you :D"
  current_tab.set_url(url)
  const b64_json_info = "vidinfo_" + btoa(JSON.stringify({ url: url }))

  current_tab.set_url(url)
  webview.setAttribute("src", extracting_info + "#" + b64_json_info)

  //TODO: this is way to slow ... extract pattern
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
  */

  return show_video({ url: url, src: src, title: title }, url)
}

function fallback_to_src(url: string) {
  /*
  const webview = document.querySelector<Electron.WebviewTag>("#webview")

  const src_fail =
    data_video_url +
    "<title>extraction failed</title>" +
    "We couldn't find a video. Sending you back to the original site."
  const b64_json_info = "vidinfo_" + btoa(JSON.stringify({ url: url }))

  webview.setAttribute("src", src_fail + "#" + b64_json_info)

  setTimeout(() => {
    video_button_inactive()
    webview.setAttribute("src", url)
  }, 2000)*/
}

function show_video(
  video_info: {
    url: string
    src: { src: string; type?: string; title?: string }
    title: string
  },
  url: string
): boolean {
  //const webview = document.querySelector<Electron.WebviewTag>("#webview")

  if (video_info && video_info.src) {
    //current_tab.set_url(url)
    video_info.title = video_info.title.replace(/[\u0250-\ue007]/g, "")
    const b64_json_info = "vidinfo_" + btoa(JSON.stringify(video_info))

    const vid_ready = () => {
      video_button_active()
      /* webview.loadURL(
        player_html_path + "?" + Math.random() + "#" + b64_json_info
      )
      current_tab.set_url(url)
      webview.removeEventListener("dom-ready", vid_ready)*/
    }
    try {
      vid_ready()
    } catch (e) {
      //webview.addEventListener("dom-ready", vid_ready)
    }
    return true
  } else {
    fallback_to_src(url)
  }
  return false
}

function zerobup(num: number): string {
  return num < 10 ? "0" + num : num.toString()
}

function formtime(secs: number): string {
  const fhours = zerobup(Math.floor(secs / 3600))
  const fmins = zerobup(Math.floor((secs / 60) % 60))
  const fsecs = zerobup(Math.floor(secs % 60))
  return `${fhours}:${fmins}:${fsecs}.000`
}

function generate_vtt(conf: VTT_Conf): string {
  let vtt_string = `WEBVTT

`

  let x = 0
  while (x <= conf.count) {
    const start = formtime(conf.interval * x)
    const end = formtime(conf.interval * (x + 1))

    vtt_string += `${start} --> ${end}\n`

    let img_url = conf.img_url

    const x_start = conf.width * (x % conf.cols)
    const width = conf.width
    let y_start = conf.height * Math.floor(x / conf.cols)
    const height = conf.height

    const n = Math.floor(x / (conf.cols * conf.rows))
    img_url = conf.img_url.replace("$N", `M${n}`)
    y_start =
      (conf.height * Math.floor(x / conf.cols)) % (conf.rows * conf.height)

    /*
    if(conf.schnibble){
      $n = floor(x / ((conf.cols * conf.rows) ));
      $img_url = str_replace("$N", "$n", conf.img_url)
      $y_start = (conf.height * floor(x / conf.cols)) % ((conf.rows) * conf.height );
    }*/

    vtt_string += `${img_url}#xywh=${x_start},${y_start},${width},${height}\n\n`
    x += 1
  }

  let data_url = "data:text/plain;base64,"
  data_url += btoa(vtt_string)

  return data_url
}

async function source_youtube(
  id: string,
  url: string
): Promise<{
  src: string
  type?: string
  title?: string
  provider: string
  id: string
  vtt_data: string
}> {
  const resp = await fetch("https://www.youtube.com/watch?ucbcb=1&v=" + id)
  if (resp.ok) {
    const text = await resp.text()
    const dp = new DOMParser()
    const ydoc = dp.parseFromString(text, "text/html")
    const conf_var = "ytInitialPlayerResponse"
    const scriptle = Array.from(ydoc.querySelectorAll("script")).filter(
      (script) => {
        return (
          script.innerText.includes(conf_var) &&
          script.innerText.includes("streamingData")
        )
      }
    )
    if (scriptle.length != 0) {
      const title = ydoc.querySelector("title").innerText

      let yt_config_raw = scriptle[0].innerText.split(conf_var)[1]
      const first_bracket = yt_config_raw.indexOf("{")

      yt_config_raw = yt_config_raw.slice(first_bracket)

      let yt_config: {
        assets: { js?: string }
        args?: { player_response?: string }
      }

      if (yt_config_raw) {
        let player_response: PlayerResponse
        try {
          player_response = JSON.parse(yt_config_raw)
        } catch (e) {
          console.debug("yt json error", e)
          const numnum = e.toString().match(/; in JSON at position (\d+)/)
          if (numnum) {
            player_response = JSON.parse(yt_config_raw.substring(0, numnum[1]))
          }
        }
        try {
          let vtt_data: string

          if (player_response.storyboards.playerStoryboardSpecRenderer) {
            const sel =
              player_response.storyboards.playerStoryboardSpecRenderer.spec.split(
                "|"
              )
            const url_pattern = sel[0].replace("$L", "2")
            const image_info = sel[3].split("#")
            const conf: VTT_Conf = {
              cols: parseInt(image_info[3]),
              rows: parseInt(image_info[4]),
              width: parseInt(image_info[0]),
              height: parseInt(image_info[1]),
              interval: parseInt(image_info[5]) / 1000,
              count: parseInt(image_info[2]),
              img_url: url_pattern + "&sigh=" + image_info[7],
              schnibble: false,
            }

            vtt_data = generate_vtt(conf)
          }

          if (player_response.streamingData.dashManifestUrl) {
            return {
              src: player_response.streamingData.dashManifestUrl,
              type: "application/dash+xml",
              title: title,
              provider: "youtube",
              id: id,
              vtt_data: vtt_data,
            }
          }
          if (
            player_response.streamingData.adaptiveFormats[0].signatureCipher
          ) {
            let base_js = null
            if (yt_config && yt_config.assets && yt_config.assets.js) {
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

                for (const format of player_response.streamingData
                  .adaptiveFormats) {
                  const ul = new URLSearchParams(format.signatureCipher)
                  /*const webview =
                    document.querySelector<Electron.WebviewTag>("#webview")
                  const defunged = await webview.executeJavaScript(
                    fungy_code + "\n" + `fungy(atob("${btoa(ul.get("s"))}"))`
                  )
                  format.url =
                    ul.get("url") + "&" + ul.get("sp") + "=" + defunged*/
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
          return {
            src: dash_src.src,
            type: dash_src.type,
            title: title,
            provider: "youtube",
            id: id,
            vtt_data: vtt_data,
          }
        } catch (e) {
          console.error("yt ", e)
        }
      }
    }
  }
}

declare interface VTT_Conf {
  cols: number
  rows: number
  width: number
  height: number
  interval: number
  count: number
  img_url: string
  schnibble: boolean
}

declare interface PlayerResponse {
  videoDetails?: {
    lengthSeconds?: number
  }
  storyboards?: {
    playerStoryboardSpecRenderer: {
      spec: string
    }
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
