import type { OnceClient } from "@once/app"
import { decodePairingLink, describeSyncConnection, encodePairingLink, PairingPayload } from "@once/core"
import qrcode from "qrcode-generator"
import { requireElement } from "../dom"

const SHOWN_FOR_MS = 60_000

/**
 * Settings › Sync › Pair a device. Showing a code warns first, since it
 * carries the database password, and only adds the add-on sync passphrase
 * when asked to and after checking it. Connecting from a link or a scanned
 * code names the database and user before anything changes.
 */
export function bindPairingControls(client: OnceClient, scan?: () => Promise<string | null>): (link: string) => void {
  const panel = requireElement<HTMLElement>("#pair_panel")
  const input = requireElement<HTMLInputElement>("#pair_link_input")
  const status = requireElement<HTMLElement>("#pair_status")
  const scanButton = requireElement<HTMLButtonElement>("#pair_scan")
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let consent: "not-needed" | "required" | "granted" = "not-needed"
  const refreshConsent = () => void client.getSyncConsent().then((state) => { consent = state }).catch(() => undefined)
  refreshConsent()

  // The page offers a code straight away; showing one replaces the offer
  // until it is hidden again, by hand or after a minute.
  let showingCode = false
  const offer = () => {
    clearTimeout(hideTimer)
    showingCode = false
    void renderOffer(client, panel, (link) => {
      showingCode = true
      renderCode(panel, link, offer)
      clearTimeout(hideTimer)
      hideTimer = setTimeout(offer, SHOWN_FOR_MS)
    })
  }
  offer()
  client.subscribe("syncStatusChanged", () => { if (!showingCode) offer() })

  const connect = (link: string) => {
    let payload: PairingPayload
    try {
      payload = decodePairingLink(link)
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "This is not a pairing link"
      return
    }
    const { database, user } = describeSyncConnection(payload.syncUrl)
    void confirmPairing(`Connect to ${database}${user ? ` as ${user}` : ""}?`,
      payload.passphrase
        ? "This replaces the current sync connection and unlocks add-on sync with the passphrase in the link."
        : "This replaces the current sync connection.",
      // The browser asks for consent only while the click is being handled.
      () => consent === "required" ? client.requestSyncConsent() : Promise.resolve(true))
      .then(async (confirmed) => {
        if (!confirmed) return
        input.value = ""
        status.textContent = "Connecting…"
        await client.setSyncUrl(payload.syncUrl)
        status.textContent = payload.passphrase ? "Connected. Waiting for add-on sync…" : "Connected"
        if (payload.passphrase) status.textContent = await unlockAddonSync(client, payload.passphrase)
      })
      .catch((error) => { status.textContent = error instanceof Error ? error.message : "Pairing failed" })
      .finally(refreshConsent)
  }
  requireElement<HTMLButtonElement>("#pair_connect").addEventListener("click", () => connect(input.value))
  if (scan) {
    scanButton.hidden = false
    scanButton.addEventListener("click", () => void scan().then((link) => { if (link) connect(link) })
      .catch((error) => { status.textContent = error instanceof Error ? error.message : "Scanning failed" }))
  }
  return connect
}

/** The warning, the passphrase choice, and the button that makes the code. */
async function renderOffer(client: OnceClient, panel: HTMLElement, showCode: (link: string) => void): Promise<void> {
  const syncUrl = await client.getSyncUrl()
  const warning = document.createElement("p")
  warning.className = "pair_warning"
  warning.textContent = syncUrl
    ? "This code contains your sync password. Anyone who sees or photographs it can read and change your synced data."
    : "Connect sync on this device first; then it can show a code for your other devices."
  delete panel.dataset.showing
  panel.replaceChildren(warning)
  if (!syncUrl) return
  const vault = await client.getAddonVaultStatus().catch(() => null)
  const hasVault = vault?.state === "ready" || vault?.state === "locked"
  const include = document.createElement("label")
  include.className = "field_check pair_include"
  const includeBox = document.createElement("input")
  includeBox.type = "checkbox"
  includeBox.dataset.testid = "pair-include-passphrase"
  include.append(includeBox, " Also include the add-on sync passphrase")
  const passphrase = document.createElement("input")
  passphrase.type = "password"
  passphrase.autocomplete = "current-password"
  passphrase.placeholder = "Add-on sync passphrase"
  passphrase.setAttribute("aria-label", "Add-on sync passphrase")
  passphrase.dataset.testid = "pair-passphrase"
  passphrase.hidden = true
  const stronger = document.createElement("p")
  stronger.className = "pair_warning"
  stronger.hidden = true
  stronger.textContent = "With the passphrase, the code also opens your synced add-on tokens and settings."
  includeBox.addEventListener("change", () => { passphrase.hidden = stronger.hidden = !includeBox.checked })
  const make = document.createElement("button")
  make.type = "button"
  make.className = "button pair_make"
  make.textContent = "Show code"
  make.dataset.testid = "pair-make"
  const feedback = document.createElement("p")
  feedback.setAttribute("role", "status")
  make.addEventListener("click", () => void (async () => {
    const withPassphrase = includeBox.checked
    if (withPassphrase && !await client.verifyAddonVaultPassphrase(passphrase.value)) {
      feedback.textContent = "That passphrase does not open add-on sync"
      return
    }
    showCode(encodePairingLink({ syncUrl, ...(withPassphrase ? { passphrase: passphrase.value } : {}) }))
    passphrase.value = ""
  })().catch(() => { feedback.textContent = "The code could not be made" }))
  if (hasVault) panel.append(include, stronger, passphrase)
  panel.append(make, feedback)
}

/** The QR code, blurred until clicked, with the same link to copy; it goes away after a minute. */
function renderCode(panel: HTMLElement, link: string, hide: () => void): void {
  panel.dataset.showing = "code"
  const code = qrcode(0, "M")
  code.addData(link)
  code.make()
  const size = code.getModuleCount()
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", `-4 -4 ${size + 8} ${size + 8}`)
  svg.setAttribute("role", "img")
  svg.setAttribute("aria-label", "Pairing code")
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  background.setAttribute("x", "-4")
  background.setAttribute("y", "-4")
  background.setAttribute("width", String(size + 8))
  background.setAttribute("height", String(size + 8))
  background.setAttribute("fill", "#fff")
  const modules = document.createElementNS("http://www.w3.org/2000/svg", "path")
  let path = ""
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`
  }
  modules.setAttribute("d", path)
  modules.setAttribute("fill", "#000")
  svg.append(background, modules)
  const frame = document.createElement("button")
  frame.type = "button"
  frame.className = "pair_code"
  frame.dataset.testid = "pair-code"
  frame.dataset.blurred = "true"
  frame.setAttribute("aria-label", "Reveal the pairing code")
  frame.append(svg)
  frame.addEventListener("click", () => {
    frame.dataset.blurred = "false"
    frame.setAttribute("aria-label", "Pairing code")
  }, { once: true })
  const copy = document.createElement("button")
  copy.type = "button"
  copy.className = "button"
  copy.textContent = "Copy pairing link"
  copy.dataset.testid = "pair-copy"
  copy.addEventListener("click", () => void copyText(link).then((copied) => { copy.textContent = copied ? "Copied" : "Copy failed" }))
  const done = document.createElement("button")
  done.type = "button"
  done.className = "button"
  done.textContent = "Hide"
  done.addEventListener("click", hide)
  const note = document.createElement("p")
  note.className = "settings_row_hint"
  note.textContent = "Click the code to reveal it. It hides itself after a minute."
  panel.replaceChildren(frame, note, copy, done)
}

/** Asks before replacing the connection; `beforeConnect` runs within the click, for a browser's consent prompt. */
function confirmPairing(question: string, detail: string, beforeConnect: () => Promise<boolean>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog")
    dialog.className = "device_picker"
    dialog.dataset.testid = "pair-confirm"
    const title = document.createElement("p")
    title.className = "device_picker_title"
    title.textContent = question
    const text = document.createElement("p")
    text.textContent = detail
    const yes = document.createElement("button")
    yes.type = "button"
    yes.className = "button"
    yes.textContent = "Connect"
    const no = document.createElement("button")
    no.type = "button"
    no.className = "button"
    no.textContent = "Cancel"
    let answer: Promise<boolean> = Promise.resolve(false)
    yes.addEventListener("click", () => {
      answer = beforeConnect().then((granted) => {
        if (!granted) throw new Error("Sync needs your permission to send data to the server")
        return true
      })
      dialog.close()
    })
    no.addEventListener("click", () => dialog.close())
    dialog.addEventListener("close", () => { dialog.remove(); answer.then(resolve, reject) }, { once: true })
    dialog.append(title, text, yes, no)
    document.body.append(dialog)
    dialog.showModal()
  })
}

/** Waits for the vault to replicate after connecting, then unlocks it with the link's passphrase. */
async function unlockAddonSync(client: OnceClient, passphrase: string): Promise<string> {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const status = await client.getAddonVaultStatus().catch(() => null)
    if (status?.state === "ready") return "Connected; add-on sync is unlocked"
    if (status?.state === "locked") {
      const name = (await client.getTabSync().catch(() => null))?.self?.name ?? ""
      await client.unlockAddonVault(passphrase, false, status.protectedStorage === true, name)
      return "Connected; add-on sync is unlocked"
    }
    if (status?.state === "disabled" && client.getSyncStatus().state === "up-to-date") return "Connected; there is no add-on sync to unlock"
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return "Connected, but add-on sync has not arrived yet; unlock it in Settings › Sync"
}

/** Copies through the async clipboard, or the older command where a shell refuses it. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement("textarea")
    field.value = text
    field.setAttribute("readonly", "")
    field.className = "visually_hidden"
    document.body.append(field)
    field.select()
    const copied = document.execCommand("copy")
    field.remove()
    return copied
  }
}
