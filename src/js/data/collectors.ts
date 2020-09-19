import * as path from "path"
import * as fs from "fs"

export { get_active, get_parser }

function get_active() {
  //TODO: determine if active from settings
  var normalizedPath = path.join(__dirname, "collectors")

  return fs
    .readdirSync(normalizedPath)
    .map((file_name: string) => {
      //TODO: better check
      if (file_name.endsWith(".js")) {
        return require(path.join(normalizedPath, file_name))
      }
    })
    .filter((x: string) => {
      return x != undefined
    })
}

function get_parser() {
  return get_active().filter((x: string) => {
    return x.hasOwnProperty("parse")
  })
}
