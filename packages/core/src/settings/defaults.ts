import { Redirect } from "../story/URLRedirect"
import { StorySourceDocument } from "./storySource"

export const defaultStorySources: StorySourceDocument = {
  version: 2,
  groups: [],
  sources: [
    { id: "src_05c15ad4", url: "https://news.ycombinator.com/" },
    { id: "src_5ef04b53", url: "https://news.ycombinator.com/news?p=2" },
    { id: "src_87d89ef4", url: "https://news.ycombinator.com/news?p=3" },
    { id: "src_fc314bd3", url: "https://lobste.rs/" },
    { id: "src_c73b5b63", url: "https://old.reddit.com/r/netsec/.rss" }
  ]
}

export const defaultFilterList = `bbc.co.uk
  bbc.com
  bloomberg.com
  brave.com
  buzzfeed.com
  cnbc.com
  cnn.com
  dw.com
  forbes.com
  fortune.com
  foxnews.com
  hbr.org
  latimes.com
  mercurynews.com
  mozilla.org
  newyorker.com
  npr.org
  nytimes.com
  rarehistoricalphotos.com
  reuters.com
  sfchronicle.com
  sfgate.com
  slate.com
  techcrunch.com
  theatlantic.com
  thedailybeast.com
  thedrive.com
  theguardian.com
  thetimes.co.uk
  theverge.com
  vice.com
  vox.com
  washingtonpost.com
  wired.com
  wsj.com
  yahoo.com`
  .split("\n")
  .map((x) => x.trim())

export function parseRedirectList(lines: string): Redirect[] {
  return lines.split("\n").map((line) => {
    const split = line.trim().split(" => ")
    return { match_url: split[0], replace_url: split[1] }
  })
}

export function presentRedirectList(redirectList: Redirect[]): string {
  return redirectList
    .map((entry) => entry.match_url + " => " + entry.replace_url)
    .join("\n")
}

export const defaultRedirectList = parseRedirectList("https:\\/\\/www.reddit.com\\/(.*) => https://old.reddit.com/$1")
