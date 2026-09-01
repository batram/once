// WebExtension `_locales/<lang>/messages.json` lookup and `__MSG_key__`
// substitution, the subset that manifests and `browser.i18n.getMessage` need.
// https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Internationalization

export interface LocaleMessage {
  readonly message: string
  readonly placeholders?: Readonly<Record<string, { readonly content: string }>>
}

export type LocaleMessages = Readonly<Record<string, LocaleMessage>>

const MSG_REFERENCE = /__MSG_([A-Za-z0-9_@]+)__/g

function substitutionAt(substitutions: readonly string[], index: number): string {
  return substitutions[index - 1] ?? ""
}

/** Replaces `$1`..`$9` from substitutions and `$$` with a literal `$`. */
function applySubstitutions(text: string, substitutions: readonly string[]): string {
  return text.replace(/\$([1-9]|\$)/g, (_match, token: string) =>
    token === "$" ? "$" : substitutionAt(substitutions, Number(token))
  )
}

export function getLocaleMessage(
  messages: LocaleMessages,
  key: string,
  substitutions: readonly string[] = []
): string {
  const entry = messages[key]
  if (!entry) return ""
  let text = entry.message
  if (entry.placeholders) {
    for (const [name, placeholder] of Object.entries(entry.placeholders)) {
      const content = applySubstitutions(placeholder.content, substitutions)
      text = text.replace(new RegExp(`\\$${escapeRegExp(name)}\\$`, "gi"), () => content)
    }
  }
  return applySubstitutions(text, substitutions)
}

/** Resolves every `__MSG_key__` in a manifest string; unknown keys become empty. */
export function localizeManifestString(text: string, messages: LocaleMessages): string {
  return text.replace(MSG_REFERENCE, (_match, key: string) => getLocaleMessage(messages, key))
}

/**
 * Which locale directories to try, most specific first, ending with the
 * manifest's default. `en-US` yields `en_US`, `en`, then the default.
 */
export function localeCandidates(locale: string, defaultLocale: string | null): string[] {
  const normalized = locale.replace(/-/g, "_")
  const candidates = [normalized]
  const separator = normalized.indexOf("_")
  if (separator > 0) candidates.push(normalized.slice(0, separator))
  if (defaultLocale && !candidates.includes(defaultLocale)) candidates.push(defaultLocale)
  return candidates
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
