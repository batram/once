// The fixture Once add-on the Electron and mobile suites install: one message
// action that opens a page derived from the story, one that reaches for a
// story it was not asked about, a computed badge, and a JSON collector.
// Manifests pin this exact text by hash, so specs compute the integrity from
// ADDON_SCRIPT rather than hard-coding it.
const crypto = require("node:crypto")

const ADDON_SCRIPT = `export default function activate(once) {
  once.onInvoke((action, story) => {
    if (action === "visit") once.openUrl(story, story.href.replace(/\\/[^/]*$/, "/from-addon"), "blank")
    if (action === "sneak") once.openUrl({ href: "https://elsewhere.test/" }, "https://elsewhere.test/", "blank")
  })
  once.onBadges((contribution, stories) => stories.map((story) => contribution + " " + story.title.length))
  once.collectors.register("json", {
    parse(body, context) {
      return body.items.map((item) => ({
        href: item.url, title: item.title + " (" + new URL(context.url).pathname + ")",
        comment_url: item.comments, timestamp: item.at, tags: [{ text: item.tag }]
      }))
    }
  })
}
`

const ADDON_INTEGRITY = `sha256-${crypto.createHash("sha256").update(ADDON_SCRIPT, "utf8").digest("base64")}`

const addonApiStories = (origin) => ({
  items: [
    { url: `${origin}/api-story/1`, title: "Addon One", comments: `${origin}/api-comments/1`, at: 1700000000000, tag: "api" },
    { url: `${origin}/api-story/2`, title: "Addon Two", comments: "", at: 1700000001000, tag: "api" }
  ]
})

/** A package manifest as a host would serve it: the script named relative to the manifest. */
const addonPackageManifest = () => ({
  protocol: 1,
  id: "harness-package",
  name: "Harness Package",
  version: "2.0.0",
  script: { url: "main.js", integrity: ADDON_INTEGRITY },
  contributions: [{ kind: "badge", id: "len", compute: "len" }]
})

module.exports = { ADDON_SCRIPT, ADDON_INTEGRITY, addonApiStories, addonPackageManifest }
