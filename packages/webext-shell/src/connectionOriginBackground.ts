/**
 * Requests the panel makes on its own behalf leave without the extension's
 * Origin header, as they do from Electron's main process and the mobile apps'
 * native HTTP client.
 *
 * A browser stamps `Origin: chrome-extension://…` or `moz-extension://…` on
 * every POST an extension page sends, and fetch cannot unset it. Some
 * services refuse any foreign Origin outright: YouTube's InnerTube player,
 * which the What? Wait, who, why? add-on asks for a video's caption tracks,
 * answers 403 to one, so its transcripts never arrived in the side panels.
 *
 * Only requests the extension itself initiates match, never a web page's, and
 * only the hosts listed here: removing Origin elsewhere would change requests
 * that work today.
 */

export interface RequestRulesApi {
  updateDynamicRules(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>
}

/** InnerTube refuses a foreign Origin; its caption downloads (/api/timedtext) do not care. */
const ORIGIN_FREE_URLS = ["||youtube.com/youtubei/"]
const FIRST_RULE_ID = 9100

export function connectionOriginRules(extensionHost: string): unknown[] {
  return ORIGIN_FREE_URLS.map((urlFilter, index) => ({
    id: FIRST_RULE_ID + index,
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
    condition: { urlFilter, initiatorDomains: [extensionHost], resourceTypes: ["xmlhttprequest"] }
  }))
}

/**
 * Dynamic rules persist across browser restarts, which a Firefox event page
 * may not wake for. Every start still replaces them, so an update that
 * changes the list takes effect without a migration.
 */
export async function installConnectionOriginBackground(rules: RequestRulesApi | undefined, extensionUrl: string): Promise<void> {
  if (!rules) return
  const added = connectionOriginRules(new URL(extensionUrl).hostname)
  await rules.updateDynamicRules({
    removeRuleIds: added.map((rule) => (rule as { id: number }).id),
    addRules: added
  })
}
