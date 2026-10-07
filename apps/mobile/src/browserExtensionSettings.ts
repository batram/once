import type { MobileBrowserExtension, MobileBrowserExtensions } from "@once/platform-mobile"
import { explained, invalidateSettingsPages, openSettingsPage, registerSettingsOverview, reportInstalledExtensions } from "@once/ui-web"

/** Marks a control the mobile e2e suite navigates through. */
function withTestId<T extends HTMLElement>(node: T, id: string): T {
  node.dataset.testid = id
  return node
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = className
  return node
}

function pageTitle(target: string, extension?: MobileBrowserExtension): string {
  return target === "overview" ? "Browser Extensions" : target === "install" ? "Install extension" :
    target === "supplemental" ? "Filter lists & userscripts" : extension?.name ?? "Extension"
}

/** Extension management stays in the shared settings section; extension pages are native sessions. */
export function bindMobileBrowserExtensionSettings(api: MobileBrowserExtensions, openBrowserUrl: (url: string) => void): void {
  const root = document.querySelector<HTMLElement>("#extension_settings")
  const title = document.querySelector<HTMLElement>("#settings_panel .settings_title")
  if (!root || !title) throw new Error("Browser extension settings elements are missing")
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
  const installed = new Map<string, MobileBrowserExtension>()
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  const report = ({ extensions = [] }: { extensions?: MobileBrowserExtension[] }) =>
    reportInstalledExtensions(extensions.length, extensions.filter(item => item.enabled).length)
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
        void show("overview")
      }
    }
  }
  // Page changes skip the busy guard: the overview's extension list may still
  // be loading when the user taps through to another page, and the generation
  // ticket discards that stale result. The guard stays for native commands.
  const navigate = (target: string, extension?: MobileBrowserExtension) => {
    let draft: Node[] | null = null
    openSettingsPage(root, {
      key: extension ? `${target}:${extension.id}` : target,
      title: () => pageTitle(target, installed.get(extension?.id ?? "") ?? extension),
      valid: () => !extension || installed.has(extension.id),
      leave: () => { if (target === "install") draft = Array.from(page.childNodes) },
      show: () => {
        void show(target, installed.get(extension?.id ?? "") ?? extension).then(() => {
          if (draft && current === target) page.replaceChildren(...draft)
        }).catch(error => { status.textContent = String(error) })
      }
    })
  }
  const control = (label: string, onClick: () => void) => {
    const node = element("button", label, "button")
    node.type = "button"
    node.addEventListener("click", onClick)
    return node
  }
  const button = (label: string, work: () => Promise<void>) => control(label, () => void run(work))
  const link = (label: string, target: string, extension?: MobileBrowserExtension) =>
    control(label, () => void navigate(target, extension))
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
    if (active()) title.textContent = pageTitle(target, extension)
    if (target === "overview") {
      page.append(...explained(api.platform === "ios"
        ? "Bundled Safari-compatible extensions for pages opened in Once."
        : "Firefox extensions for pages opened in Once.",
      api.platform === "ios" ? "Extension settings stay on this device." : "Installation and settings stay on this device."))
      if (api.platform !== "ios") page.append(link("Install extension", "install"))
      page.append(withTestId(link("Filter lists & userscripts", "supplemental"), "extension-supplemental"))
      const result = await api.command({ action: "list" })
      installed.clear()
      for (const item of result.extensions ?? []) installed.set(item.id, item)
      report(result)
      invalidateSettingsPages()
      if (generation !== ticket) return
      for (const item of result.extensions ?? []) {
        const row = link("", "detail", item)
        populateExtensionRow(row, item)
        page.append(row)
      }
      page.append(control("Refresh extensions", () => void show("overview")))
    } else if (target === "install") {
      renderInstall(page, api, button, async () => navigate("overview"), openBrowserUrl)
    } else if (target === "detail" && extension) {
      renderDetail(page, api, extension, { button, link, refreshSelected })
    } else if (target === "remove" && extension) {
      renderRemoval(page, api, extension, button, link, () => navigate("overview"))
    }
  }
  registerSettingsOverview(root, () => { void show("overview").catch(error => { status.textContent = String(error) }) })
  root.addEventListener("once:settings-reveal", event => {
    if (event.target instanceof Node && supplemental.contains(event.target) && current !== "supplemental") {
      void show("supplemental")
    }
  })
  // Listing starts Gecko, so the row learns its count from the overview's own
  // list call and from change events, never from an eager query at bind.
  void api.onChanged(() => {
    if (!active() || current !== "overview") {
      void api.command({ action: "list" }).then(report).catch(() => undefined)
      return
    }
    if (busy) refreshNeeded = true
    else void show("overview")
  }).catch(error => { status.textContent = String(error) })
  if (active()) void show("overview")
}

function renderRemoval(page: HTMLElement, api: MobileBrowserExtensions, extension: MobileBrowserExtension,
  button: PageControls["button"], link: PageControls["link"], done: () => void): void {
  page.append(element("p", `Remove ${extension.name} and its extension data from this device?`),
    button("Remove extension and data", async () => {
      await api.command({ action: "remove", id: extension.id })
      done()
    }), link("Keep extension", "detail", extension))
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

type PageControls = {
  button: (label: string, work: () => Promise<void>) => HTMLButtonElement
  link: (label: string, target: string, extension?: MobileBrowserExtension) => HTMLButtonElement
  refreshSelected: () => Promise<void>
}

function renderDetail(page: HTMLElement, api: MobileBrowserExtensions, extension: MobileBrowserExtension, controls: PageControls): void {
  const { button, link, refreshSelected } = controls
  page.append(element("h4", `${extension.name} ${extension.version}`), element("p", extension.description))
  if (extension.disabledReason) page.append(element("p", extension.disabledReason, "settings_status"))
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
    }), link("Remove extension…", "remove", extension))
  }
  page.append(...explained("Reload open pages after enabling or disabling.",
    "Removing an extension also removes its extension data. Included extensions update with Once."),
  element("h4", "Requested access"), element("p", extension.permissions.join(", ") || "None"))
}

function renderInstall(
  page: HTMLElement, api: MobileBrowserExtensions,
  button: (label: string, work: () => Promise<void>) => HTMLButtonElement,
  done: () => Promise<void>,
  openBrowserUrl: (url: string) => void
): void {
  const label = element("label", "Firefox Add-ons URL")
  const input = element("input")
  input.type = "url"
  input.id = "mobile-extension-source"
  input.placeholder = "https://addons.mozilla.org/en-US/firefox/addon/…/"
  label.htmlFor = input.id
  const catalog = element("p", "Browse the ", "settings_description")
  const catalogLink = element("a", "Firefox Add-ons catalog")
  catalogLink.href = "https://addons.mozilla.org/en-US/firefox/"
  catalogLink.addEventListener("click", event => {
    event.preventDefault()
    openBrowserUrl(catalogLink.href)
  })
  catalog.append(catalogLink, " and paste an add-on's page URL above.")
  page.append(label, input, catalog, ...explained("Choose an Android-compatible Firefox extension.",
    "Once will download it and show its verified identity and requested access before installation."))
  const install = async (source: string) => {
    const result = await api.command({ action: "install", source })
    if (!result.cancelled) await done()
  }
  const reviewButton = button("Review and install", () => install(input.value.trim()))
  // Enter in the URL field reviews, through the button so it shares its busy state.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    reviewButton.click()
  })
  page.append(reviewButton, button("Choose signed XPI file…", async () => {
    const result = await api.command({ action: "chooseFile" })
    if (!result.cancelled) await done()
  }))
  page.append(...explained("Local XPI files must be signed by Mozilla.",
    "Extension compatibility depends on Firefox for Android and the browser APIs Once supports."))
}
