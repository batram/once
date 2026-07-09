import { Redirect } from "../url/Redirect"
import { redirectUrl } from "../url/redirectUrl"

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
    return redirectUrl(url, URLRedirect.dynamic_url_redirects)
  }
}
