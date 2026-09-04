import browser = require("webextension-polyfill")

const KEY = "addonSandboxUrl"

/**
 * Where scripted add-ons may run in this extension. Chrome ships the page as
 * a manifest `sandbox` page. Firefox has no such mechanism and forbids blob:
 * scripts on extension pages, so the user names a hosted copy of
 * `addon-sandbox-hosted.html`; the choice stays in this browser's local
 * extension storage, never in the synced settings.
 */
export async function addonSandboxUrl(target: "chrome" | "firefox"): Promise<string | undefined> {
  if (target === "chrome") return browser.runtime.getURL("static/addon-sandbox.html")
  const stored = await browser.storage.local.get(KEY)
  const url = stored[KEY]
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : undefined
}

/** Reveals the Firefox-only control in the Add-ons section and saves what the user enters. */
export async function bindAddonSandboxSetting(): Promise<void> {
  const group = document.querySelector<HTMLElement>("#firefox_addon_sandbox_settings")
  const input = document.querySelector<HTMLInputElement>("#addon_sandbox_url_input")
  const save = document.querySelector<HTMLButtonElement>('[data-testid="save-addon-sandbox-url"]')
  if (!group || !input || !save) return
  group.hidden = false
  input.value = (await addonSandboxUrl("firefox")) ?? ""
  const status = document.createElement("p")
  status.className = "settings_status"
  status.setAttribute("role", "status")
  group.append(status)
  save.addEventListener("click", () => void (async () => {
    const url = input.value.trim()
    if (url && !/^https:\/\//i.test(url)) {
      status.textContent = "The sandbox page must be served over https"
      return
    }
    if (url) await browser.storage.local.set({ [KEY]: url })
    else await browser.storage.local.remove(KEY)
    status.textContent = url
      ? "Saved. Close and reopen the sidebar for scripted add-ons to use it."
      : "Cleared. Scripted add-ons are unavailable until a page is named."
  })())
}
