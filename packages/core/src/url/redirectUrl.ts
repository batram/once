import { Redirect } from "./Redirect"

export function redirectUrl(url: string, redirects: Redirect[] = []): string {
  redirects.forEach((redirect) => {
    const rex = new RegExp(redirect.match_url)
    if (url.match(rex)) {
      url = url.replace(rex, redirect.replace_url)
    }
  })

  return url
}
