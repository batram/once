import { ipcMain, session } from "electron"
import * as fs from "fs"
import * as path from "path"

export { custom_protocol }

const outline_css = fs.readFileSync(path.join(__dirname, "outline_style.css"))
const outline_font = fs.readFileSync(path.join(__dirname, "spectral.ttf"))

function custom_protocol(): void {
  let outlined = ""
  ipcMain.on("outlined", (event, data) => {
    console.log("outlined")
    outlined = data
  })

  session
    .fromPartition("moep")
    .protocol.registerBufferProtocol("outline", (request, callback) => {
      console.log("outline scheme", request.url)
      if (request.url.startsWith("outline://css")) {
        callback({ data: outline_css, mimeType: "text/css" })
      } else if (request.url.startsWith("outline://font")) {
        callback({ data: outline_font, mimeType: "font/ttf" })
      } else if (request.url.startsWith("outline://data")) {
        callback({ data: Buffer.from(outlined, "utf8"), mimeType: "text/html" })
      }
    })
}
