export { dynamic_url_filters, filter_url }

export interface URLFilter {
  (href: string): string
}

let dynamic_url_filters: Record<string, URLFilter> = {
  "twitter.com": twitnit,
  "www.reddit.com": old_reddit,
  "youtube.com": youtube_nocookie,
  "youtu.be": youtube_nocookie,
}

function filter_url(url: string) {
  for (let pattern in dynamic_url_filters) {
    if (url.includes(pattern)) {
      url = dynamic_url_filters[pattern](url)
    }
  }
  return url
}

function twitnit(href: string) {
  try {
    let url = new URL(href)
    if (url.hostname == "twitter.com" || url.hostname == "mobile.twitter.com") {
      url.hostname = "nitter.net"
      href = url.toString()
    }
  } catch (e) {
    console.log("failed to parse URL", href)
  }
  return href
}

function old_reddit(href: string) {
  try {
    let url = new URL(href)
    if (url.hostname == "www.reddit.com") {
      url.hostname = "old.reddit.com"
      href = url.toString()
    }
  } catch (e) {
    console.log("failed to parse URL", href)
  }
  return href
}

function youtube_nocookie(href: string) {
  href = href.replace(
    "www.youtube.com/watch?v=",
    "www.youtube-nocookie.com/embed/"
  )
  href = href.replace(
    "://youtube.com/watch?v=",
    "://www.youtube-nocookie.com/embed/"
  )
  href = href.replace("://youtu.be/", "://www.youtube-nocookie.com/embed/")
  return href
}
