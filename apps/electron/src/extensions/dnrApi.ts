// `browser.declarativeNetRequest`: the rule management calls over the
// host's rulesets. Enforcement happens in the webRequest router through
// `dnrBridge`; nothing here sees a request. `getMatchedRules` and
// `testMatchOutcome` are refused with a plain error, which reaches the
// extension as a rejection or `runtime.lastError`.

import { isRegexSupported } from "@once/core"
import type { ApiHandler, ApiHost } from "./ExtensionApi"
import { DnrRulesets } from "./DnrRulesets"
import { asRecord } from "./apiTargets"

type Handlers = Record<string, ApiHandler>

function rulesets(host: ApiHost): DnrRulesets {
  if (!host.dnr.available) {
    throw new Error("The declarativeNetRequest permission is required")
  }
  return host.dnr
}

function unsupported(name: string): ApiHandler {
  return () => {
    throw new Error(`declarativeNetRequest.${name} is not supported`)
  }
}

export function declarativeNetRequestHandlers(): Handlers {
  return {
    "declarativeNetRequest.getEnabledRulesets": ({ host }) => rulesets(host).getEnabledRulesets(),
    "declarativeNetRequest.updateEnabledRulesets": ({ host }, options) =>
      rulesets(host).updateEnabledRulesets(asRecord(options)),
    "declarativeNetRequest.getAvailableStaticRuleCount": ({ host }) =>
      rulesets(host).getAvailableStaticRuleCount(),
    "declarativeNetRequest.getDynamicRules": ({ host }, filter) => rulesets(host).getDynamicRules(filter),
    "declarativeNetRequest.updateDynamicRules": ({ host }, options) =>
      rulesets(host).updateDynamicRules(asRecord(options)),
    "declarativeNetRequest.getSessionRules": ({ host }, filter) => rulesets(host).getSessionRules(filter),
    "declarativeNetRequest.updateSessionRules": ({ host }, options) =>
      rulesets(host).updateSessionRules(asRecord(options)),
    "declarativeNetRequest.isRegexSupported": (_call, options) => {
      const { regex, isCaseSensitive, requireCapturing } = asRecord(options)
      if (typeof regex !== "string") throw new Error("isRegexSupported needs a regex")
      return isRegexSupported(regex, {
        isCaseSensitive: isCaseSensitive !== false,
        requireCapturing: requireCapturing === true
      })
    },
    "declarativeNetRequest.getMatchedRules": unsupported("getMatchedRules"),
    "declarativeNetRequest.testMatchOutcome": unsupported("testMatchOutcome")
  }
}
