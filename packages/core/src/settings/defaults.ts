import { Redirect } from "../story/URLRedirect"

export const defaultSources = [
  "https://news.ycombinator.com/",
  "https://news.ycombinator.com/news?p=2",
  "https://news.ycombinator.com/news?p=3",
  "https://lobste.rs/",
  "https://old.reddit.com/r/netsec/.rss"
]

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

export const defaultRedirectList = parseRedirectList(`https:\\/\\/www.reddit.com\\/(.*) => https://old.reddit.com/$1
         https?:\\/\\/(?:www\\.|mobile\\.)?(?:twitter|x)\\.com\\/(.*) => https://nitter.net/$1`)
