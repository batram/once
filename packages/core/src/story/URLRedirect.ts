import { OnceSettings } from "../OnceSettings"
import { Redirect } from "../url/Redirect"
import { redirectUrl } from "../url/redirectUrl"

interface URLRedirectOptions {
  onUpdated?: () => void
}

export class URLRedirect {
  static dynamic_url_redirects: Redirect[]
  private static onUpdated?: () => void

  static init(options: URLRedirectOptions = {}): void {
    if (options.onUpdated) {
      URLRedirect.onUpdated = options.onUpdated
    }

    const sets = OnceSettings.instance
    sets.get_redirectlist().then((x) => {
      URLRedirect.dynamic_url_redirects = x
      URLRedirect.onUpdated?.()
    })
  }

  static redirect_url(url: string): string {
    return redirectUrl(url, URLRedirect.dynamic_url_redirects)
  }
}
