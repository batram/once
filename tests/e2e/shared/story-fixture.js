// Shared story fixture for the story-list e2e suites.
// CommonJS on purpose: required by the Playwright specs (Electron, Chrome)
// and the selenium/node:test Firefox suite alike. Only data, selectors and a
// plain node:http request handler live here - no driver logic.

const STORY_TITLES = {
  alpha: "Alpha reader story",
  beta: "Beta discussion story",
  gamma: "Gamma redirect story",
  delta: "Delta delta-filter story",
  epsilon: "Epsilon accessibility notes",
  zeta: "Zeta offline interface study",
  eta: "Eta typography field guide",
  theta: "Theta browser architecture",
  iota: "Iota testing without sleeps",
  kappa: "Kappa unusually long headline for narrow layouts"
}

const SELECTORS = {
  story: "story-item",
  title: "a.title",
  og: "a.og_href",
  comment: "a.comment_url",
  readBtn: ".read_btn",
  starBtn: ".star_btn",
  filterBtn: ".filter_btn",
  outlineBtn: ".outline_btn",
  selected: "#selected_container story-item.selected"
}

// Unique token that matches only the delta story (title and href); the filter
// dialog prefills the fixture hostname, which would match every story.
const FILTER_TOKEN = "delta-filter"

function storyUrls(origin) {
  return {
    alpha: `${origin}/story/alpha`,
    beta: `${origin}/story/beta`,
    gamma: `${origin}/story/gamma`,
    delta: `${origin}/story/delta-filter-target`,
    epsilon: `${origin}/story/epsilon`,
    zeta: `${origin}/story/zeta`,
    eta: `${origin}/story/eta`,
    theta: `${origin}/story/theta`,
    iota: `${origin}/story/iota`,
    kappa: `${origin}/story/kappa`,
    rewrittenGamma: `${origin}/rewritten/gamma`,
    betaComments: `${origin}/comments/beta-1`,
    betaSubstoryComments: `${origin}/comments/beta-2`
  }
}

function feedJson(origin) {
  const urls = storyUrls(origin)
  const result = {
    items: [
      {
        href: urls.alpha,
        title: STORY_TITLES.alpha,
        published: "2030-07-15T10:00:00Z",
        author: "Ada",
        channel: "Engineering",
        topic: "reader"
      },
      {
        href: urls.beta,
        title: STORY_TITLES.beta,
        published: "2030-07-15T09:00:00Z",
        author: "Lin",
        channel: "Community",
        topic: "discussion",
        comments: urls.betaComments
      },
      // Same href with a different comments URL: OnceApp.addStory records it
      // as a substory of beta instead of a separate story.
      {
        href: urls.beta,
        title: STORY_TITLES.beta,
        published: "2030-07-15T08:55:00Z",
        author: "Sam",
        channel: "Community",
        topic: "follow-up",
        comments: urls.betaSubstoryComments
      },
      {
        href: urls.gamma,
        title: STORY_TITLES.gamma,
        published: "2030-07-15T08:00:00Z",
        author: "Mira",
        channel: "Web",
        topic: "redirects"
      },
      {
        href: urls.delta,
        title: STORY_TITLES.delta,
        published: "2030-07-15T07:00:00Z",
        author: "Noor",
        channel: "Filters",
        topic: "search"
      },
      ...[
        ["epsilon", "Rae", "Design", "accessibility"],
        ["zeta", "Kai", "Mobile", "offline"],
        ["eta", "Inez", "Design", "typography"],
        ["theta", "Bo", "Desktop", "architecture"],
        ["iota", "Uma", "Testing", "determinism"],
        ["kappa", "Sol", "Mobile", "responsive"]
      ].map(([key, author, channel, topic], index) => ({
        href: urls[key],
        title: STORY_TITLES[key],
        published: `2030-07-14T${String(18 - index).padStart(2, "0")}:00:00Z`,
        author,
        channel,
        topic
      }))
    ]
  }
  for (const item of result.items) {
    item.authorClass = "user"
    item.channelClass = "channel"
    item.topicClass = "category"
  }
  return result
}

function sourceLine(origin, feedPath = "/feed.json") {
  return JSON.stringify({ version: 2, groups: [], sources: [{
    id: "src_fixture01",
    url: `${origin}${feedPath}`,
    collector: "jsonselect",
    select: {
      stories: { sel: "items", all: true },
      link: { sel: "href" },
      title: { sel: "title" },
      timestamp: { sel: "published" },
      comment_href: { sel: "comments" },
      tags: [
        { elements: { class: { sel: "authorClass" }, text: { sel: "author" } } },
        { elements: { class: { sel: "channelClass" }, text: { sel: "channel" } } },
        { elements: { class: { sel: "topicClass" }, text: { sel: "topic" } } }
      ]
    }
  }] })
}

function rssSourceLine(origin, feedPath = "/feed.rss") {
  return `${origin}${feedPath}`
}

/**
 * One typed document holding both fixture feeds. Sources are read as a JSON
 * document or as a plain URL list, never as a mixture, so a harness that wants
 * both feeds has to say so in one document.
 */
function sourceDocument(origin, feedPath = "/feed.json", rssPath = "/feed.rss") {
  const document = JSON.parse(sourceLine(origin, feedPath))
  document.sources.push({ id: "src_fixture02", url: `${origin}${rssPath}` })
  return JSON.stringify(document)
}

function feedRss(origin) {
  const urls = storyUrls(origin)
  const keys = [
    "alpha", "beta", "gamma", "delta", "epsilon",
    "zeta", "eta", "theta", "iota", "kappa"
  ]
  const items = keys.map((key, index) => `
    <item>
      <title>${STORY_TITLES[key]}</title>
      <link>${urls[key]}</link>
      <guid>${urls[key]}</guid>
      <pubDate>${new Date(Date.UTC(2030, 6, 15, 10 - index)).toUTCString()}</pubDate>
    </item>`).join("")
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel>
      <title>Once RSS visual source</title>
      <link>${origin}/feed.rss</link>
      <description>Deterministic RSS companions for visual comparison</description>
      ${items}
    </channel></rss>`
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

function redirectRule(origin) {
  const urls = storyUrls(origin)
  return {
    line: `${escapeRegex(urls.gamma)} => ${urls.rewrittenGamma}`,
    original: urls.gamma,
    rewritten: urls.rewrittenGamma
  }
}

const ARTICLE_PARAGRAPH =
  "The reader pipeline extracts long-form content from ordinary pages. " +
  "This paragraph exists so the readability heuristics find enough article text to accept the page. " +
  "It repeats a few times to comfortably clear the extraction thresholds used by the application."

// Serves /feed.json, /story/*, /rewritten/* and /comments/*.
// Returns false for unknown paths so callers can chain their own routes.
function handleRequest(request, response, origin) {
  const path = (request.url || "").split("?")[0]

  if (path === "/failure.rss") {
    response.writeHead(503, {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*"
    })
    response.end("deterministic visual source failure")
    return true
  }

  if (path === "/feed.json") {
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    })
    response.end(JSON.stringify(feedJson(origin)))
    return true
  }

  if (path === "/feed.rss") {
    response.writeHead(200, {
      "content-type": "application/rss+xml; charset=utf-8",
      "access-control-allow-origin": "*"
    })
    response.end(feedRss(origin))
    return true
  }

  if (path === "/story/alpha") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>${STORY_TITLES.alpha}</title>
      <article>
        <h1>${STORY_TITLES.alpha}</h1>
        <p>${ARTICLE_PARAGRAPH}</p>
        <p>${ARTICLE_PARAGRAPH}</p>
        <p>${ARTICLE_PARAGRAPH}</p>
      </article>`)
    return true
  }

  if (/^\/(story|rewritten|comments)\//.test(path)) {
    const name = path.split("/").pop() || "page"
    const title = name.charAt(0).toUpperCase() + name.slice(1)
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(`<!doctype html>
      <title>${title}</title>
      <h1>${title}</h1>`)
    return true
  }

  return false
}

module.exports = {
  FILTER_TOKEN,
  SELECTORS,
  STORY_TITLES,
  feedJson,
  feedRss,
  handleRequest,
  redirectRule,
  sourceLine,
  sourceDocument,
  rssSourceLine,
  storyUrls
}
