export class Redirect {
  match_url: string
  replace_url: string
}

export class URLRedirect {
  static dynamic_url_redirects: Redirect[]

  static redirect_url(url: string): string {
    URLRedirect.dynamic_url_redirects.forEach((redirect) => {
      const rex = new RegExp(redirect.match_url)
      if (url.match(rex)) {
        url = url.replace(new RegExp(redirect.match_url), redirect.replace_url)
      }
    })
    return url
  }
}
