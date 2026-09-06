import { OnceClient } from "@once/app"
import { ElectronBridge, ElectronManagedExtension } from "@once/platform-electron/bridge"

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = className
  return result
}

/** Real extension pages remain in browser tabs; management and sync have settings subpages. */
export function bindBrowserExtensionSettings(client: OnceClient, bridge: ElectronBridge): void {
  const root = document.querySelector<HTMLElement>("#extension_settings")
  const panel = document.querySelector<HTMLElement>("#settings_panel")
  const back = panel?.querySelector<HTMLButtonElement>("#settings_section_back")
  const title = panel?.querySelector<HTMLElement>(".settings_title")
  if (!root || !panel || !back || !title) throw new Error("Browser extension settings elements are missing")
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
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  const header = () => {
    if (!active()) return
    title.textContent = current === "overview" ? "Browser Extensions" : current === "install" ? "Install extension" :
      current === "supplemental" ? "Filter lists & userscripts" : current === "sync" ? `${extension?.name} · Sync` : extension?.name ?? "Extension"
    back.textContent = current === "overview" ? "Settings" : current === "sync" ? extension?.name ?? "Extension" : "Browser Extensions"
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
  const button = (label: string, work: () => Promise<void>) => {
    const control = element("button", label, "button")
    control.type = "button"
    control.addEventListener("click", () => void run(work))
    return control
  }
  const show = async (target: string, selected = extension): Promise<void> => {
    const ticket = ++generation
    current = target
    extension = selected
    page.replaceChildren()
    supplemental.hidden = target !== "supplemental"
    page.hidden = target === "supplemental"
    header()
    await renderExtensionPage({ target, selected, page, bridge, client, button, show, isCurrent: () => ticket === generation })
  }

  back.addEventListener("click", event => {
    if (!active() || current === "overview") return
    event.stopImmediatePropagation()
    void run(() => show(current === "sync" ? "detail" : "overview"))
  }, true)
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || current === "overview" || (event.target instanceof Element && event.target.matches("input,textarea,select"))) return
    event.stopPropagation()
    void run(() => show(current === "sync" ? "detail" : "overview"))
  })
  let wasActive = false
  new MutationObserver(() => {
    const now = active()
    if (now === wasActive) return
    wasActive = now
    if (now) void run(() => show("overview"))
  }).observe(panel, { subtree: true, attributes: true, attributeFilter: ["class"] })
  bridge.extensions.onChanged(() => { if (active() && current === "overview" && !busy) void run(() => show("overview")) })
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
  void run(() => show("overview"))
}

interface PageContext {
  target: string
  selected?: ElectronManagedExtension
  page: HTMLElement
  bridge: ElectronBridge
  client: OnceClient
  button(label: string, work: () => Promise<void>): HTMLButtonElement
  show(target: string, selected?: ElectronManagedExtension): Promise<void>
  isCurrent(): boolean
}

async function renderExtensionPage({ target, selected, page, bridge, client, button, show, isCurrent }: PageContext): Promise<void> {
  if (target === "overview") {
    page.append(element("p", "Install Firefox extensions for pages opened in Once. Installation and enabled state belong to this device.", "settings_description"))
    const actions = element("div", "", "settings_actions cluster")
    actions.append(button("Install extension", () => show("install")), button("Filter lists & userscripts", () => show("supplemental")))
    page.append(actions)
    const installed = await bridge.extensions.installed()
    if (!isCurrent()) return
    page.append(element("h4", `Your extensions (${installed.length})`, "settings_group_title"))
    for (const item of installed) {
      const row = button("", () => show("detail", item))
      row.className = "browser_extension_row"
      row.setAttribute("aria-label", `Manage ${item.name}`)
      row.append(element("strong", item.name), element("span", item.description, "addon_list_description"),
        element("span", `${item.version} · ${item.error ? "Needs attention" : item.running ? "Enabled" : "Disabled"} · ${item.bundled ? "Included with Once" : "Installed"}`, "addon_list_meta"))
      page.append(row)
    }
  } else if (target === "install") {
    const label = element("label", "Firefox Add-ons URL")
    const input = element("input")
    input.type = "url"
    input.placeholder = "https://addons.mozilla.org/en-US/firefox/addon/…/"
    input.id = "browser-extension-source"
    label.htmlFor = input.id
    page.append(label, input)
    const review = element("section", "", "settings_group")
    const preview = async (source: string) => {
      const candidate = await bridge.extensions.preview(source)
      if (!candidate || !isCurrent()) return
      review.replaceChildren(element("h4", `${candidate.name} ${candidate.version}`), element("p", candidate.description),
        element("p", candidate.source), element("p", `Requested access: ${candidate.permissions.join(", ") || "No additional permissions"}`))
      for (const warning of candidate.warnings) review.append(element("p", warning, "settings_description"))
      review.append(button(candidate.update ? "Update extension" : "Install reviewed extension", async () => {
        await bridge.extensions.install(candidate.token)
        await show("overview")
      }))
    }
    const actions = element("div", "", "settings_actions cluster")
    actions.append(button("Review extension", () => preview(input.value.trim())), button("Choose XPI file…", () => preview("")))
    page.append(actions, element("p", "Extensions can read and change pages within their requested access. Review the source and permissions before installing.", "settings_description"))
    for (const [name, slug] of [["SponsorBlock", "sponsorblock"], ["Dark Reader", "darkreader"]]) {
      page.append(button(`Review ${name}`, () => preview(`https://addons.mozilla.org/en-US/firefox/addon/${slug}/`)))
    }
    page.append(review)
  } else if (target === "detail" && selected) {
    page.append(element("h4", `${selected.name} ${selected.version}`), element("p", selected.description), element("p", selected.source))
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
    const sync = button("Choose settings to sync", () => show("sync", selected))
    sync.disabled = !selected.running
    actions.append(sync)
    if (!selected.bundled) actions.append(button("Remove extension", async () => {
      await bridge.extensions.remove(selected.id)
      await show("overview")
    }))
    page.append(actions, element("p", "Reload open pages to apply enable/disable changes. Removing an extension keeps its local settings for a later reinstall.", "settings_description"),
      element("h4", "Requested access"), element("p", selected.permissions.join(", ") || "None"))
    for (const warning of selected.warnings) page.append(element("p", warning, "settings_description"))
  } else if (target === "sync" && selected) {
    const [storage, doc] = await Promise.all([bridge.extensions.storage(selected.id), client.getBrowserExtensionSync()])
    if (!isCurrent()) return
    page.append(element("p", "Choose individual storage keys to share through Once’s CouchDB sync. Nothing is selected by default. A key can contain several preferences; select only data you want on your other devices. Cookies, IndexedDB, and localStorage are not included.", "settings_description"))
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
