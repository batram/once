import { OnceSettings } from "../OnceSettings"
import { BackComms } from "./BackComms"
import { Redirect, redirectUrl } from "@once/core"

export { Redirect }

export class URLRedirect {
  static dynamic_url_redirects: Redirect[]

  static init(): void {
    const sets = OnceSettings.instance
    sets.get_redirectlist().then((x) => {
      URLRedirect.dynamic_url_redirects = x
      BackComms.send("story_list", "update_redirects")
    })
  }

  static redirect_url(url: string): string {
    return redirectUrl(url, URLRedirect.dynamic_url_redirects)
  }
}
