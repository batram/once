/* global browser */
// AMO's Android button links to an XPI (and can hand off to Firefox). Keep
// its responsive styling, but route the action through Once's native review.
// This runs in the isolated extension world: the page gets no native API.
if (window === window.top && location.origin === "https://addons.mozilla.org") {
  let pending = false
  let installed = new Set()
  const added = new Set()
  const post = async action => {
    const result = JSON.parse(await browser.runtime.sendNativeMessage("once_amo", { action }))
    if (result.error) throw new Error(result.error)
    return result
  }
  const listing = () => location.pathname.match(/^\/(?:[A-Za-z-]+\/)?(?:firefox|android)\/addon\/([A-Za-z0-9_-]+)\/?$/)?.[1]
  const addonId = () => {
    try {
      const state = JSON.parse(document.getElementById("redux-store-state")?.textContent || "{}")
      return Object.values(state.addons?.byID || {}).find(addon => addon.slug === listing())?.guid
    } catch { return undefined }
  }
  const controls = () => document.querySelectorAll(".AMInstallButton-button")
  const render = () => {
    if (!listing()) return
    const present = added.has(listing()) || installed.has(addonId())
    for (const button of controls()) {
      const label = pending ? "Adding to Once…" : present ? "Added to Once" : "Add to Once"
      if (button.textContent !== label) button.textContent = label
      if (button.tagName === "A") {
        if (button.getAttribute("href") !== "#") button.setAttribute("href", "#")
        button.setAttribute("role", "button")
      }
      button.setAttribute("aria-disabled", String(pending || present))
      if (button.tagName === "BUTTON") button.disabled = pending || present
    }
  }
  const refresh = async () => {
    try {
      const result = await post("list")
      installed = new Set(result.extensions.map(extension => extension.id))
      added.clear()
      render()
    } catch { /* The next pageshow/focus retries after a host reconnect. */ }
  }
  const activate = async event => {
    const button = event.target.closest?.(".AMInstallButton-button")
    if (!button || !listing()) return
    if (event.type === "keydown" && event.key !== " " && event.key !== "Enter") return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (pending || added.has(listing()) || installed.has(addonId())) return
    const slug = listing()
    pending = true
    document.getElementById("once-amo-error")?.remove()
    render()
    try {
      const result = await post("install")
      if (!result.cancelled) {
        installed = new Set(result.extensions.map(extension => extension.id))
        added.add(slug)
      }
    } catch (error) {
      if (slug === listing()) {
        const message = document.createElement("p")
        message.id = "once-amo-error"
        message.setAttribute("role", "alert")
        message.textContent = "Could not add to Once: " + (error.message || String(error))
        button.closest(".AMInstallButton")?.append(message)
      }
    } finally {
      pending = false
      render()
    }
  }
  window.addEventListener("click", activate, true)
  window.addEventListener("keydown", activate, true)
  // Observe React replacements and client-side listing navigation as well as
  // the initial server render. Attribute changes include AMO restoring href.
  new MutationObserver(render).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href"] })
  window.addEventListener("pageshow", refresh)
  window.addEventListener("focus", refresh)
  render()
}
