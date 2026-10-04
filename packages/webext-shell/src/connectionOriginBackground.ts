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
  updateSessionRules?(options: { removeRuleIds?: number[]; addRules?: unknown[] }): Promise<void>
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
 * The comments panel frames a story's comments page, and most comment sites
 * forbid that (Hacker News sends `X-Frame-Options: DENY` and CSP
 * `frame-ancestors 'self'`), which leaves the panel showing the browser's
 * refusal. Pages framed in the panel arrive without those two headers. A rule cannot edit one CSP directive, so
 * the framed page loses its whole policy while it is in the panel; the same
 * page in a tab, or framed by any web page, keeps both.
 *
 * Two conditions: the frames the extension's pages load themselves, and
 * every frame outside a tab, so that a page the reader reaches by following a
 * link inside the frame (which the site itself then initiates) is let in too.
 * Browsers only allow a tab condition on session rules, which every
 * background start reinstalls.
 */
export function panelFrameRules(extensionHost: string): unknown[] {
  const action = {
    type: "modifyHeaders",
    responseHeaders: [
      { header: "x-frame-options", operation: "remove" },
      { header: "content-security-policy", operation: "remove" }
    ]
  }
  return [
    { id: FIRST_RULE_ID + 50, priority: 1, action, condition: { initiatorDomains: [extensionHost], resourceTypes: ["sub_frame"] } },
    { id: FIRST_RULE_ID + 51, priority: 1, action, condition: { tabIds: [-1], resourceTypes: ["sub_frame"] } }
  ]
}

const ruleIds = (rules: unknown[]): number[] => rules.map((rule) => (rule as { id: number }).id)

/**
 * Dynamic rules persist across browser restarts, which a Firefox event page
 * may not wake for. Every start still replaces them, so an update that
 * changes the list takes effect without a migration.
 */
export async function installConnectionOriginBackground(rules: RequestRulesApi | undefined, extensionUrl: string): Promise<void> {
  if (!rules) return
  const host = new URL(extensionUrl).hostname
  const added = connectionOriginRules(host)
  await rules.updateDynamicRules({ removeRuleIds: ruleIds(added), addRules: added })
  // Without session rules the panel shows only the comment sites that allow framing.
  const frames = panelFrameRules(host)
  await rules.updateSessionRules?.({ removeRuleIds: ruleIds(frames), addRules: frames })
}
