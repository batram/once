import type { MobileBrowserExtension, MobileBrowserExtensions } from "@once/platform-mobile"

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

/** Android management stays in the shared settings section; extension pages are native sessions. */
export function bindMobileBrowserExtensionSettings(api: MobileBrowserExtensions): void {
  const root = document.querySelector<HTMLElement>("#extension_settings")
  const panel = document.querySelector<HTMLElement>("#settings_panel")
  const back = document.querySelector<HTMLButtonElement>("#settings_section_back")
  const title = panel?.querySelector<HTMLElement>(".settings_title")
  if (!root || !panel || !back || !title) throw new Error("Browser extension settings elements are missing")
  const supplemental = wrapSupplemental(root)
  const page = element("div", "", "mobile_extension_page")
  const status = element("p", "", "settings_status")
  status.setAttribute("role", "status")
  root.append(page, supplemental, status)
  let current = "overview"
  let selected: MobileBrowserExtension | undefined
  let generation = 0
  let busy = false
  let refreshNeeded = false
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    busy = true
    root.setAttribute("aria-busy", "true")
    status.textContent = "Working…"
    try { await work(); status.textContent = "" }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    finally {
      busy = false
      root.removeAttribute("aria-busy")
      if (refreshNeeded && active() && current === "overview") {
        refreshNeeded = false
        void run(() => show("overview"))
      }
    }
  }
  const button = (label: string, work: () => Promise<void>) => {
    const node = element("button", label, "button")
    node.type = "button"
    node.addEventListener("click", () => void run(work))
    return node
  }
  const refreshSelected = async () => {
    const result = await api.command({ action: "list" })
    const entry = result.extensions?.find(item => item.id === selected?.id)
    await show(entry ? "detail" : "overview", entry)
  }
  const show = async (target: string, extension = selected) => {
    const ticket = ++generation
    current = target
    selected = extension
    page.replaceChildren()
    supplemental.hidden = target !== "supplemental"
    page.hidden = target === "supplemental"
    if (active()) {
      title.textContent = target === "overview" ? "Browser Extensions" : target === "install" ? "Install extension" :
        target === "supplemental" ? "Filter lists & userscripts" : extension?.name ?? "Extension"
      back.textContent = target === "overview" ? "Settings" : "Browser Extensions"
    }
    if (target === "overview") {
      page.append(element("p", "Firefox extensions for pages opened in Once. Installation and settings stay on this device.", "settings_description"))
      page.append(button("Install extension", () => show("install")), button("Filter lists & userscripts", () => show("supplemental")))
      const result = await api.command({ action: "list" })
      if (generation !== ticket) return
      for (const item of result.extensions ?? []) {
        const row = button("", () => show("detail", item))
        populateExtensionRow(row, item)
        page.append(row)
      }
      page.append(button("Refresh extensions", () => show("overview")))
    } else if (target === "install") {
      renderInstall(page, api, button, () => show("overview"))
    } else if (target === "detail" && extension) {
      page.append(element("h4", `${extension.name} ${extension.version}`), element("p", extension.description))
      page.append(button(extension.enabled ? "Disable extension" : "Enable extension", async () => {
        await api.command({ action: "enable", id: extension.id, enabled: !extension.enabled })
        await refreshSelected()
      }))
      if (extension.hasOptions || extension.hasAction) {
        const options = button("Open extension settings", async () => { await api.command({ action: "options", id: extension.id }) })
        options.disabled = !extension.enabled
        page.append(options)
      }
      if (extension.hasAction) {
        const action = button("Open extension action", async () => { await api.command({ action: "action", id: extension.id }) })
        action.disabled = !extension.enabled
        page.append(action)
      }
      if (!extension.bundled) {
        page.append(button("Check for update", async () => {
          await api.command({ action: "update", id: extension.id })
          await refreshSelected()
        }), button("Remove extension…", () => show("remove", extension)))
      }
      page.append(element("p", "Reload open pages after enabling or disabling. Removing an extension also removes its extension data. Included extensions update with Once.", "settings_description"),
        element("h4", "Requested access"), element("p", extension.permissions.join(", ") || "None"))
    } else if (target === "remove" && extension) {
      page.append(element("p", `Remove ${extension.name} and its extension data from this device?`),
        button("Remove extension and data", async () => {
          await api.command({ action: "remove", id: extension.id })
          await show("overview")
        }), button("Keep extension", () => show("detail", extension)))
    }
  }
  back.addEventListener("click", event => {
    if (!active() || current === "overview") return
    event.stopImmediatePropagation()
    if (!busy) void run(() => show("overview"))
  }, true)
  let wasActive = active()
  new MutationObserver(() => {
    const now = active()
    if (now === wasActive) return
    wasActive = now
    if (now) void run(() => show("overview"))
  }).observe(panel, { subtree: true, attributes: true, attributeFilter: ["class"] })
  void api.onChanged(() => {
    if (!active() || current !== "overview") return
    if (busy) refreshNeeded = true
    else void run(() => show("overview"))
  }).catch(error => { status.textContent = String(error) })
  void run(() => show("overview"))
}

function wrapSupplemental(root: HTMLElement): HTMLElement {
  const supplemental = element("div")
  supplemental.append(...Array.from(root.children))
  return supplemental
}

function populateExtensionRow(row: HTMLButtonElement, item: MobileBrowserExtension): void {
  row.className = "mobile_extension_row"
  row.setAttribute("aria-label", `Manage ${item.name}`)
  row.append(extensionTitle(item), element("span", item.description),
    element("span", `${item.version} · ${item.enabled ? "Enabled" : "Disabled"}${item.bundled ? " · Included with Once" : ""}`, "mobile_extension_meta"))
}

function extensionTitle(extension: MobileBrowserExtension): HTMLElement {
  const title = element("span", "", "mobile_extension_title")
  const icon = element("img", "", "mobile_extension_icon")
  const fallback = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8f96b2" stroke-width="1.8" stroke-linejoin="round"><path d="M9 3H4v6H3a3 3 0 0 0 0 6h1v6h6v-1a3 3 0 0 1 6 0v1h5v-6h-1a3 3 0 0 1 0-6h1V3h-6V2a3 3 0 0 0-6 0Z"/></svg>')
  icon.alt = ""
  icon.width = 20
  icon.height = 20
  icon.src = extension.iconDataUrl?.startsWith("data:image/png;base64,") ? extension.iconDataUrl : fallback
  icon.addEventListener("error", () => { icon.src = fallback }, { once: true })
  title.append(icon, element("strong", extension.name))
  return title
}

function renderInstall(
  page: HTMLElement, api: MobileBrowserExtensions,
  button: (label: string, work: () => Promise<void>) => HTMLButtonElement,
  done: () => Promise<void>
): void {
  const label = element("label", "Firefox Add-ons URL")
  const input = element("input")
  input.type = "url"
  input.id = "mobile-extension-source"
  input.placeholder = "https://addons.mozilla.org/en-US/firefox/addon/…/"
  label.htmlFor = input.id
  page.append(label, input, element("p", "Choose an Android-compatible Firefox extension. Once will download it and show its verified identity and requested access before installation.", "settings_description"))
  const install = async (source: string) => {
    const result = await api.command({ action: "install", source })
    if (!result.cancelled) await done()
  }
  page.append(button("Review and install", () => install(input.value.trim())), button("Choose signed XPI file…", async () => {
    const result = await api.command({ action: "chooseFile" })
    if (!result.cancelled) await done()
  }))
  page.append(element("p", "Local XPI files must be signed by Mozilla. Extension compatibility depends on Firefox for Android and the browser APIs Once supports.", "settings_description"))
  for (const [name, slug] of [["Dark Reader", "darkreader"], ["SponsorBlock", "sponsorblock"]]) {
    page.append(button(`Review ${name}`, () => install(`https://addons.mozilla.org/en-US/firefox/addon/${slug}/`)))
  }
}
