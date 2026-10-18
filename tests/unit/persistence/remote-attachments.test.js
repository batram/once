const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const express = require("express")
const PouchDB = require("pouchdb")
const couchServer = require("../../helpers/couch-server")
const { protectRemoteAttachments } = require("../../../packages/persistence/dist")

test("replication preserves HTML attachment bytes when an intermediary rewrites raw attachment responses", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-attachment-transport-"))
  const Db = PouchDB.defaults({ prefix: directory + path.sep })
  const api = couchServer(Db, { mode: "minimumForPouchDB", inMemoryConfig: true })
  const source = new Db("source"), target = new Db("target")
  const original = '<a href="mailto:person@example.test">Contact</a>\r\n'
  await source.put({ _id: "story", _attachments: { content: { content_type: "text/html", data: Buffer.from(original).toString("base64") } } })
  const app = express()
  let rawReads = 0
  app.get("/source/story/content", (_request, response) => { rawReads++; response.type("html").send("<a href='/cdn-cgi/l/email-protection'>Changed</a>") })
  app.use(api)
  const server = await new Promise(resolve => { const started = app.listen(0, "127.0.0.1", () => resolve(started)) })
  // Authenticated PouchDB mutates Headers with .set(); a plain object only
  // appears to work on an unauthenticated fixture.
  const remote = new PouchDB(`http://127.0.0.1:${server.address().port}/source`, {
    skip_setup: true, auth: { username: "fixture", password: "fixture" }
  })
  t.after(async () => {
    await remote.close()
    await new Promise(resolve => server.close(resolve))
    await source.destroy(); await target.destroy()
    // express-pouchdb retains its catalog handle until this test worker exits.
  })
  assert.notEqual((await remote.getAttachment("story", "content")).toString(), original)
  protectRemoteAttachments(remote)
  await PouchDB.replicate(remote, target)
  assert.equal((await target.getAttachment("story", "content")).toString(), original)
  assert.equal(rawReads, 1, "protected replication must never fetch the transformed raw endpoint")
  const revision = (await target.get("story"))._rev
  assert.equal((await remote.getAttachment("story", "content", { rev: revision })).toString(), original)
  await assert.rejects(remote.getAttachment("story", "missing"), { status: 404 })
})
