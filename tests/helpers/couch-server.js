const express = require("express")
const expressPouchDB = require("express-pouchdb")

/** express-pouchdb 4 omits the POST _changes selector body that CouchDB supports. */
module.exports = function couchServer(PouchDB, options) {
  const api = expressPouchDB(PouchDB, options)
  const server = express()
  const parseSelector = express.json({ limit: "1mb" })
  server.post("/:db/_changes", (request, response, next) => {
    if (request.query.filter !== "_selector") return next()
    parseSelector(request, response, error => {
      if (error) return next(error)
      if (request.body?.selector) request.query.selector = request.body.selector
      next()
    })
  })
  server.use(api)
  return server
}
