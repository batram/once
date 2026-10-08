import { OnceClient } from "@once/app"
import { ElectronBridge, ElectronManagedExtension } from "@once/platform-electron/bridge"
import { explained, invalidateSettingsPages, openSettingsPage, registerSettingsOverview, reportInstalledExtensions } from "@once/ui-web"

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

type ExtensionSummary = Pick<ElectronManagedExtension, "name" | "icon" | "version" | "permissions">

function extensionHeading(item: ExtensionSummary, text = item.name): HTMLElement {
  const heading = element("span", "", "browser_extension_heading")
  const icon = element("span", item.name.slice(0, 1).toUpperCase(), "browser_extension_icon")
  icon.setAttribute("aria-hidden", "true")
  if (item.icon) {
    const image = element("img")
    image.src = item.icon
    image.alt = ""
    image.onerror = () => icon.replaceChildren(document.createTextNode(item.name.slice(0, 1).toUpperCase()))
    icon.replaceChildren(image)
  }
  heading.append(icon, element("strong", text))
  return heading
}

function permissionList(item: ExtensionSummary): HTMLElement[] {
  const list = element("ul", "", "browser_extension_permissions")
  for (const permission of item.permissions) list.append(element("li", permission))
  if (!item.permissions.length) list.append(element("li", "No additional permissions"))
  return [element("p", "Requested access", "browser_extension_label"), list]
}

/** Real extension pages remain in browser tabs; management and sync have settings subpages. */
export function bindBrowserExtensionSettings(client: OnceClient, bridge: ElectronBridge): void {
  const root = document.querySelector<HTMLElement>("#extension_settings")
  const panel = document.querySelector<HTMLElement>("#settings_panel")
  const title = panel?.querySelector<HTMLElement>(".settings_title")
  if (!root || !panel || !title) throw new Error("Browser extension settings elements are missing")
  const supplemental = element("div")
  supplemental.append(...Array.from(root.children))
  const page = element("div", "", "browser_extension_page")
  const status = element("p", "", "settings_status")
  status.setAttribute("role", "status")
  root.append(page, supplemental, status)
  let current = "overview"
  let extension: ElectronManagedExtension | undefined
  let generation = 0
  let busy = false
  const installed = new Map<string, ElectronManagedExtension>()
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  const header = () => {
    if (!active()) return
    title.textContent = current === "overview" ? "Browser Extensions" : current === "install" ? "Install extension" :
      current === "supplemental" ? "Filter lists & userscripts" : current === "sync" ? `${extension?.name} · Sync` : extension?.name ?? "Extension"
  }
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    busy = true
    status.textContent = "Working…"
    root.setAttribute("aria-busy", "true")
    try { await work(); status.textContent = "" }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
    finally { busy = false; root.removeAttribute("aria-busy") }
  }
  const button = (label: string, work: () => Promise<void>, navigation = false) => {
    const control = element("button", label, "button")
    control.type = "button"
    control.addEventListener("click", () => {
      if (navigation) void work().catch(error => { status.textContent = String(error) })
      else void run(work)
    })
    return control
  }
  const render = async (target: string, selected = extension): Promise<void> => {
    const ticket = ++generation
    current = target
    extension = selected
    page.replaceChildren()
    supplemental.hidden = target !== "supplemental"
    page.hidden = target === "supplemental"
    header()
    await renderExtensionPage({ target, selected, page, bridge, client, button, show,
      link: (label, target, selected) => button(label, () => show(target, selected), true),
      isCurrent: () => ticket === generation || (current === target && extension?.id === selected?.id) })
  }
  const show = async (target: string, selected = extension): Promise<void> => {
    // Commands can refresh their current view without adding another visit.
    if (current === target && selected?.id === extension?.id && target !== "supplemental") {
      await render(target, selected)
      return
    }
    let draft: Node[] | null = null
    let pending = Promise.resolve()
    openSettingsPage(root, {
      key: selected && ["detail", "sync"].includes(target) ? `${target}:${selected.id}` : target,
      parentKey: target === "sync" && selected ? `detail:${selected.id}` : undefined,
      title: () => target === "overview" ? "Browser Extensions" : target === "install" ? "Install extension" :
        target === "supplemental" ? "Filter lists & userscripts" : target === "sync" ? `${selected?.name} · Sync` : selected?.name ?? "Extension",
      valid: () => !selected || !["detail", "sync"].includes(target) || installed.has(selected.id),
      leave: () => { if (["install", "sync"].includes(target)) draft = Array.from(page.childNodes) },
      show: () => {
        if (draft) {
          ++generation
          current = target
          extension = selected
          page.replaceChildren(...draft)
          page.hidden = false
          supplemental.hidden = true
          header()
        } else pending = render(target, installed.get(selected?.id ?? "") ?? selected)
          .catch(error => { status.textContent = String(error) })
      }
    })
    await pending
  }
  registerSettingsOverview(root, () => { void render("overview").catch(error => { status.textContent = String(error) }) })
  root.addEventListener("once:settings-reveal", event => {
    if (event.target instanceof Node && supplemental.contains(event.target) && current !== "supplemental") void render("supplemental")
  })
  // The settings row summarises what is installed whether or not this section
  // is open, so the count is reported on every change, not only when rendering.
  const report = () => bridge.extensions.installed().then(items => {
    installed.clear()
    for (const item of items) installed.set(item.id, item)
    reportInstalledExtensions(items.length, items.filter(item => item.running).length)
    invalidateSettingsPages()
  }).catch(() => undefined)
  bridge.extensions.onInstalledChanged(() => {
    void report()
    if (active() && current === "overview" && !busy) void run(() => render("overview"))
  })
  void report()
  bindBrowserExtensionSync(client, bridge, status)
  void render("overview").catch(error => { status.textContent = String(error) })
}

/** Settings synchronization does not participate in navigation or its busy state. */
function bindBrowserExtensionSync(client: OnceClient, bridge: ElectronBridge, status: HTMLElement): void {
  let exchange = Promise.resolve()
  const apply = () => {
    exchange = exchange.then(async () => bridge.extensions.applySync(await client.getBrowserExtensionSync())).catch(error => { status.textContent = `Extension sync failed: ${error}` })
  }
  client.subscribe("settingsChanged", ({ section }) => { if (section === "extensions") apply() })
  bridge.extensions.onSyncChanged(doc => {
    exchange = exchange.then(() => client.updateBrowserExtensionSync(latest => {
      for (const [id, source] of Object.entries(doc.extensions)) {
        const target = latest.extensions[id]
        if (!target) continue
        for (const area of ["local", "sync"] as const) {
          for (const key of target[area]) {
            if (!source[area].includes(key)) continue
            if (Object.hasOwn(source.values[area], key)) Object.defineProperty(target.values[area], key, {
              value: source.values[area][key], configurable: true, writable: true, enumerable: true
            })
            else Reflect.deleteProperty(target.values[area], key)
          }
        }
      }
      return latest
    })).catch(error => { status.textContent = `Could not save extension sync: ${error}` })
  })
  apply()
}

interface PageContext {
  target: string
  selected?: ElectronManagedExtension
  page: HTMLElement
  bridge: ElectronBridge
  client: OnceClient
  button(label: string, work: () => Promise<void>): HTMLButtonElement
  show(target: string, selected?: ElectronManagedExtension): Promise<void>
  link(label: string, target: string, selected?: ElectronManagedExtension): HTMLButtonElement
  isCurrent(): boolean
}

/** The Add-ons URL or XPI chooser, its review, and the install from that review. */
function renderInstallPage({ page, bridge, button, show, isCurrent }: PageContext): void {
  const label = element("label", "Firefox Add-ons URL")
  const input = element("input")
  input.type = "url"
  input.placeholder = "https://addons.mozilla.org/en-US/firefox/addon/…/"
  input.id = "browser-extension-source"
  label.htmlFor = input.id
  page.append(label, input)
  const review = element("section", "", "browser_extension_review")
  review.hidden = true
  const preview = async (source: string) => {
    const candidate = await bridge.extensions.preview(source)
    if (!candidate || !isCurrent()) return
    const heading = element("h4")
    heading.append(extensionHeading(candidate))
    review.replaceChildren(heading, element("p", candidate.description, "addon_list_description"),
      element("p", `${candidate.version} · ${candidate.update ? "Update" : "Not installed"} · ${candidate.source}`, "addon_list_meta"), ...permissionList(candidate))
    for (const warning of candidate.warnings) review.append(element("p", warning, "settings_description"))
    const actions = element("div", "", "settings_actions cluster")
    actions.append(button(candidate.update ? "Update extension" : "Install reviewed extension", async () => {
      await bridge.extensions.install(candidate.token)
      await show("overview")
    }))
    review.append(actions)
    review.hidden = false
  }
  const actions = element("div", "", "settings_actions cluster")
  const reviewButton = button("Review extension", () => preview(input.value.trim()))
  // Enter in the URL field reviews, through the button so it shares its busy state.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    reviewButton.click()
  })
  actions.append(reviewButton, button("Choose XPI file…", () => preview("")))
  const catalog = element("p", "Browse the ", "settings_description")
  const catalogLink = element("a", "Firefox Add-ons catalog")
  catalogLink.href = "https://addons.mozilla.org/en-US/firefox/"
  // The shell routes `_blank` links into a tab, where the site's own
  // "Add to Firefox" button adds to Once.
  catalogLink.target = "_blank"
  catalogLink.rel = "noopener"
  catalog.append(catalogLink, " and add from there, or paste an add-on's page or XPI link above.")
  page.append(actions, catalog, element("p", "Extensions can read and change pages within their requested access. Review the source and permissions before installing.", "settings_description"), review)
}

async function renderExtensionPage({ target, selected, page, bridge, client, button, link, show, isCurrent }: PageContext): Promise<void> {
  if (target === "overview") {
    page.append(...explained("Install Firefox extensions for pages opened in Once.", "Installation and enabled state belong to this device."))
    const actions = element("div", "", "settings_actions cluster")
    actions.append(link("Install extension", "install"), link("Filter lists & userscripts", "supplemental"))
    page.append(actions)
    const installed = await bridge.extensions.installed()
    if (!isCurrent()) return
    page.append(element("h4", `Your extensions (${installed.length})`, "settings_group_title"))
    for (const item of installed) {
      const row = link("", "detail", item)
      row.className = "browser_extension_row"
      row.setAttribute("aria-label", `Manage ${item.name}`)
      row.append(extensionHeading(item), element("span", item.description, "addon_list_description"),
        element("span", `${item.version} · ${item.error ? "Needs attention" : item.running ? "Enabled" : "Disabled"} · ${item.bundled ? "Included with Once" : "Installed"}`, "addon_list_meta"))
      page.append(row)
    }
  } else if (target === "install") {
    renderInstallPage({ target, selected, page, bridge, client, button, link, show, isCurrent })
  } else if (target === "detail" && selected) {
    const heading = element("h4")
    heading.append(extensionHeading(selected, `${selected.name} ${selected.version}`))
    page.append(heading, element("p", selected.description), element("p", selected.source))
    if (selected.error) page.append(element("p", selected.error, "settings_status"))
    const actions = element("div", "", "settings_actions cluster")
    actions.append(button(selected.running ? "Disable extension" : "Enable extension", async () => {
      await bridge.extensions.setEnabled(selected.id, !selected.running)
      await show("detail", (await bridge.extensions.installed()).find(item => item.id === selected.id))
    }))
    if (selected.hasOptions || selected.hasPopup) {
      const options = button("Open extension settings", () => bridge.extensions.openOptions(selected.id))
      options.disabled = !selected.running
      actions.append(options)
    }
    const sync = link("Choose settings to sync", "sync", selected)
    sync.disabled = !selected.running
    actions.append(sync)
    if (!selected.bundled) actions.append(button("Remove extension", async () => {
      await bridge.extensions.remove(selected.id)
      await show("overview")
    }))
    page.append(actions, ...explained("Reload open pages to apply enable/disable changes.", "Removing an extension keeps its local settings for a later reinstall."),
      ...permissionList(selected))
    for (const warning of selected.warnings) page.append(element("p", warning, "settings_description"))
  } else if (target === "sync" && selected) {
    const [storage, doc] = await Promise.all([bridge.extensions.storage(selected.id), client.getBrowserExtensionSync()])
    if (!isCurrent()) return
    page.append(...explained("Choose storage keys to share through Once’s CouchDB sync. Nothing is selected by default.",
      "A key can contain several preferences; select only data you want on your other devices. Cookies, IndexedDB, and localStorage are not included."))
    const controls: { area: "local" | "sync"; key: string; input: HTMLInputElement }[] = []
    for (const area of ["local", "sync"] as const) {
      const group = element("fieldset", "", "settings_group")
      group.append(element("legend", `Extension storage.${area}`))
      const keys = [...new Set([...Object.keys(storage[area]), ...doc.extensions[selected.id]?.[area] ?? []])].sort()
      if (!keys.length) group.append(element("p", "No keys yet. Open the extension settings and configure it first."))
      for (const key of keys) {
        const label = element("label", "", "settings_group_hint")
        const input = element("input")
        input.type = "checkbox"
        input.checked = doc.extensions[selected.id]?.[area].includes(key) ?? false
        label.append(input, document.createTextNode(` ${key}`))
        group.append(label, element("br"))
        controls.push({ area, key, input })
      }
      page.append(group)
    }
    page.append(button("Save sync selection", async () => {
      const values = await bridge.extensions.storage(selected.id)
      const local = controls.filter(control => control.area === "local" && control.input.checked).map(control => control.key)
      const sync = controls.filter(control => control.area === "sync" && control.input.checked).map(control => control.key)
      await client.updateBrowserExtensionSync(latest => {
        Object.defineProperty(latest.extensions, selected.id, {
          value: { local, sync, values }, enumerable: true, writable: true, configurable: true
        })
        return latest
      })
      await bridge.extensions.applySync(await client.getBrowserExtensionSync())
      await show("detail", selected)
    }))
  }
}
