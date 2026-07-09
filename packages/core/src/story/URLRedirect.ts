export interface Redirect {
  match_url: string
  replace_url: string
}


interface URLRedirectOptions {
  getRedirects?: () => Promise<Redirect[]>
  onUpdated?: () => void
}

export class URLRedirect {
  static dynamic_url_redirects: Redirect[]
  private static onUpdated?: () => void

  static init(options: URLRedirectOptions = {}): void {
    if (options.onUpdated) {
      URLRedirect.onUpdated = options.onUpdated
    }

    options.getRedirects?.().then((redirects) => {
      URLRedirect.setRedirects(redirects)
    })
  }

  static setRedirects(redirects: Redirect[]): void {
    URLRedirect.dynamic_url_redirects = redirects
    URLRedirect.onUpdated?.()
  }

  static redirect_url(url: string): string {
    URLRedirect.dynamic_url_redirects.forEach((redirect) => {
      const rex = new RegExp(redirect.match_url)
      if (url.match(rex)) {
        url = url.replace(rex, redirect.replace_url)
      }
    })

    return url
  }
}
