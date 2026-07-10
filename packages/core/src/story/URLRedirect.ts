export interface Redirect {
  match_url: string
  replace_url: string
}

export class URLRedirect {
  static dynamic_url_redirects: Redirect[] = []

  static setRedirects(redirects: Redirect[]): void {
    URLRedirect.dynamic_url_redirects = redirects
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
