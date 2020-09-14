module.exports = {
  get_active,
  get_parser,
}

function get_active() {
  //TODO: determine if active from settings
  var normalizedPath = require("path").join(__dirname, "collectors")

  return require("fs")
    .readdirSync(normalizedPath)
    .map((file) => {
      return require("./collectors/" + file)
    })
}

function get_parser() {
  return get_active().filter((x) => {
    return x.hasOwnProperty("parse")
  })
}
