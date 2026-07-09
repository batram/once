//import { ipcMain, session } from "electron"
//import * as fs from "fs"
//import * as path from "path"
//import * as tabbed_out from "../../../view/tabbed_out"
//import { Menu, MenuItem } from "electron"
//import { CMenuData } from "../../../view/contextmenu"

//const outline_css = fs.readFileSync(path.join(__dirname, "outline_style.css"))
//const outline_font = fs.readFileSync(path.join(__dirname, "spectral.ttf"))
const outlined: Record<string, string> = {}

export function custom_protocol(): void {
  /*
  ipcMain.on("outlined", (event, url, data) => {
    console.debug("outlined", url)
    outlined[url] = data
    event.returnValue = true
  })

  ipcMain.on("has_outlined", (event, url) => {
    console.debug("has_outlined", url)
    event.returnValue = Object.prototype.hasOwnProperty.call(outlined, url)
  })

  ipcMain.on("get_outlined", (event, url) => {
    console.debug("get_outlined", url)
    event.returnValue = outlined[url]
  })

  session
    .fromPartition("moep")
    .protocol.registerBufferProtocol("outline", (request, callback) => {
      console.log("outline scheme", request.url)
      if (request.url.startsWith("outline://css")) {
        callback({ data: outline_css, mimeType: "text/css" })
      } else if (request.url.startsWith("outline://font")) {
        callback({ data: outline_font, mimeType: "font/ttf" })
      } else if (request.url.startsWith("outline://data:")) {
        const split = request.url.split("outline://data:")
        const url = decodeURIComponent(split[1])
        console.log("outline data", url)
        callback({
          data: Buffer.from(outlined[url], "utf8"),
          mimeType: "text/html",
        })
      }
    })*/
}

export function context_link(/*con_menu: Menu, cmenu_data: CMenuData*/): void {
  /*
  con_menu.append(
    new MenuItem({
      id: "url_reader_open",
      label: "Open in reader",
      click: () => {
        tabbed_out.send_to_parent(
          { sender: cmenu_data.sender },
          "send_to_new_tab",
          "outline",
          cmenu_data.href
        )
      },
    })
  )*/
}
