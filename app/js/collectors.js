module.exports = {
  get_active,
  get_parser,
}

const path = require("path")

function get_active() {
  //TODO: determine if active from settings
  var normalizedPath = path.join(__dirname, "collectors")

  return require("fs")
    .readdirSync(normalizedPath)
    .map((file) => {
      //TODO: better check
      if (file.endsWith(".js")) {
        return require(path.join(normalizedPath, file))
      }
    })
    .filter((x) => {
      return x != undefined
    })
}

function get_parser() {
  return get_active().filter((x) => {
    return x.hasOwnProperty("parse")
  })
}
