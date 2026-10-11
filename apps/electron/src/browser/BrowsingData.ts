import { BrowserWindow, dialog, ipcMain, session, Session, webContents } from "electron"
import { hostBelongsToSite, siteForUrl } from "@once/app/browsingSite"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { BROWSER_SESSION_PARTITION, BrowserCoordinator } from "../TabManager"

// Clears what websites stored in the browsing partition. Nothing else is
// touched: the shell and its database live in the default session, and each
// extension keeps its storage on disk and its pages in its own partition.

const browsingSession = (): Session => session.fromPartition(BROWSER_SESSION_PARTITION)

/**
 * Everything one site stored, its subdomains included. Chromium clears storage
 * per exact origin (scheme, host and port) and cannot list the origins it holds
 * data for, so they are gathered from what can name them: the site's usual
 * hosts, the hosts its cookies were set for, and every page in the history of
 * the open tabs. Storage of an origin on an unusual port that no open tab ever
 * visited is out of reach; its cookies are not, since those ignore ports.
 */
export async function clearSiteData(site: string): Promise<void> {
  const ses = browsingSession()
  const origins = new Set<string>()
  const addHost = (host: string) => {
    origins.add(`https://${host}`)
    origins.add(`http://${host}`)
  }
  addHost(site)
  if (site.includes(".") && !/^[\d.]+$|:/.test(site)) addHost(`www.${site}`)
  for (const cookie of await ses.cookies.get({})) {
    const domain = (cookie.domain ?? "").replace(/^\./, "")
    if (!hostBelongsToSite(domain, site)) continue
    addHost(domain)
    const scheme = cookie.secure ? "https" : "http"
    await ses.cookies.remove(`${scheme}://${domain}${cookie.path ?? "/"}`, cookie.name)
  }
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed() || contents.session !== ses) continue
    for (const entry of contents.navigationHistory.getAllEntries()) {
      const origin = webOrigin(entry.url)
      if (origin && hostBelongsToSite(new URL(origin).hostname, site)) origins.add(origin)
    }
  }
  // Storage is partitioned by top-level site, and each matching mode reaches
  // one side of it: the default takes what other sites' frames stored inside
  // this site, origin-in-all-contexts what this site's frames stored inside
  // other sites (browsing-data-third-party.spec.js shows both).
  await ses.clearData({ origins: [...origins] })
  await ses.clearData({ origins: [...origins], originMatchingMode: "origin-in-all-contexts" })
}

function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}

export async function clearAllBrowsingData(): Promise<void> {
  const ses = browsingSession()
  await ses.clearData()
  await ses.clearAuthCache()
  await ses.clearHostResolverCache()
}

/** The shell's settings call these after asking the user themselves. */
export function registerBrowsingDataHandlers(coordinator: BrowserCoordinator): void {
  ipcMain.handle(ELECTRON_IPC.browsingDataClearSite, (event, site: unknown) => {
    coordinator.requireWindow(event)
    // A bare site is its own registrable domain; anything else is refused
    // rather than widened, so a subdomain never clears its parent.
    if (typeof site !== "string" || siteForUrl(`https://${site}/`) !== site) throw new Error("Invalid site")
    return clearSiteData(site)
  })
  ipcMain.handle(ELECTRON_IPC.browsingDataClearAll, (event) => {
    coordinator.requireWindow(event)
    return clearAllBrowsingData()
  })
}

/** Asks before clearing one site, from a native menu of `window`. */
export async function confirmClearSiteData(window: BrowserWindow, site: string): Promise<void> {
  if (window.isDestroyed()) return
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Clear", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Clear data for ${site}?`,
    detail: "Cookies, cache and stored data for this site and its subdomains are removed. You will be signed out of it. Open pages may need a reload."
  })
  if (response === 0) await clearSiteData(site)
}
