export interface Redirect {
  match_url: string
  replace_url: string
}

interface CompiledRedirect {
  rex: RegExp
  replace_url: string
}

export class URLRedirect {
  static dynamic_url_redirects: Redirect[] = []
  private static compiled_redirects: CompiledRedirect[] = []
  //memoized results: original url -> rewritten url (identity when no rule matches)
  private static rewritten_urls = new Map<string, string>()
  //reverse lookup: rewritten url -> original url
  private static original_urls = new Map<string, string>()

  static setRedirects(redirects: Redirect[]): void {
    URLRedirect.dynamic_url_redirects = redirects
    URLRedirect.rewritten_urls.clear()
    URLRedirect.original_urls.clear()
    URLRedirect.compiled_redirects = []
    redirects.forEach((redirect) => {
      try {
        URLRedirect.compiled_redirects.push({
          rex: new RegExp(redirect.match_url),
          replace_url: redirect.replace_url
        })
      } catch (error) {
        console.warn("skipping invalid redirect rule", redirect.match_url, error)
      }
    })
  }

  static redirect_url(url: string): string {
    const cached = URLRedirect.rewritten_urls.get(url)
    if (cached !== undefined) {
      return cached
    }

    let rewritten = url
    URLRedirect.compiled_redirects.forEach(({ rex, replace_url }) => {
      if (rewritten.match(rex)) {
        rewritten = rewritten.replace(rex, replace_url)
      }
    })

    URLRedirect.rewritten_urls.set(url, rewritten)
    if (rewritten !== url) {
      URLRedirect.original_urls.set(rewritten, url)
    }

    return rewritten
  }

  //map a rewritten url back to the url it was rewritten from
  static original_url(url: string): string {
    return URLRedirect.original_urls.get(url) ?? url
  }
}
