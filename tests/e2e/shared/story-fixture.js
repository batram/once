// Shared story fixture for the story-list e2e suites.
// CommonJS on purpose: required by the Playwright specs (Electron, Chrome)
// and the selenium/node:test Firefox suite alike. Only data, selectors and a
// plain node:http request handler live here - no driver logic.

const STORY_TITLES = {
  alpha: "Alpha reader story",
  beta: "Beta discussion story",
  gamma: "Gamma redirect story",
  delta: "Delta delta-filter story"
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
    rewrittenGamma: `${origin}/rewritten/gamma`,
    betaComments: `${origin}/comments/beta-1`,
    betaSubstoryComments: `${origin}/comments/beta-2`
  }
}

function feedJson(origin) {
  const urls = storyUrls(origin)
  return {
    items: [
      {
        href: urls.alpha,
        title: STORY_TITLES.alpha,
        published: "2024-03-04T05:06:07Z"
      },
      {
        href: urls.beta,
        title: STORY_TITLES.beta,
        published: "2024-03-03T05:06:07Z",
        comments: urls.betaComments
      },
      // Same href with a different comments URL: OnceApp.addStory records it
      // as a substory of beta instead of a separate story.
      {
        href: urls.beta,
        title: STORY_TITLES.beta,
        published: "2024-03-03T04:06:07Z",
        comments: urls.betaSubstoryComments
      },
      {
        href: urls.gamma,
        title: STORY_TITLES.gamma,
        published: "2024-03-02T05:06:07Z"
      },
      {
        href: urls.delta,
        title: STORY_TITLES.delta,
        published: "2024-03-01T05:06:07Z"
      }
    ]
  }
}

function sourceLine(origin) {
  return `json:§§${JSON.stringify({
    stories: { sel: "items", all: true },
    link: { sel: "href" },
    title: { sel: "title" },
    timestamp: { sel: "published" },
    comment_href: { sel: "comments" },
    tags: []
  })}§§${origin}/feed.json`
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

  if (path === "/feed.json") {
    response.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*"
    })
    response.end(JSON.stringify(feedJson(origin)))
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
  handleRequest,
  redirectRule,
  sourceLine,
  storyUrls
}
