const STORAGE_KEY = "once:mobile-domain-search"

export function domainSearchEnabled(): boolean {
  if (document.body.dataset.platform !== "mobile") return true
  try {
    return localStorage.getItem(STORAGE_KEY) === "true"
  } catch { return false }
}

export function updateDomainLink(link: HTMLAnchorElement): void {
  const search = domainSearchEnabled()
  link.href = search ? `search:domain:${link.dataset.domain}` : (link.dataset.storyUrl ?? "")
  if (search) link.target = "search"
  else link.removeAttribute("target")
}

export function mountDomainLinkSetting(input: HTMLInputElement): void {
  const section = input.closest<HTMLElement>("section")
  if (section) section.hidden = document.body.dataset.platform !== "mobile"
  input.checked = domainSearchEnabled()
  input.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEY, String(input.checked))
    document.querySelectorAll<HTMLAnchorElement>("story-item .hostname")
      .forEach(updateDomainLink)
  })
}
