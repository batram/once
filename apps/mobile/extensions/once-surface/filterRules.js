// The portable subset is deliberate: a constraint is never silently discarded.
globalThis.onceFilterRules = (() => {
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  function pattern(source) {
    let value = source
    let prefix = ""
    if (value.startsWith("||")) { value = value.slice(2); prefix = "^https?://(?:[^/]+\\.)?" }
    else if (value.startsWith("|")) { value = value.slice(1); prefix = "^" }
    const end = value.endsWith("|")
    if (end) value = value.slice(0, -1)
    return new RegExp(prefix + escape(value).replace(/\\\*/g, ".*")
      .replace(/\\\^/g, "(?:[^A-Za-z0-9_.%-]|$)") + (end ? "$" : ""), "i")
  }
  function parse(text) {
    const blocked = [], allowed = [], selectors = []
    let skipped = 0, unsafeException = false
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith("!") || line.startsWith("[")) continue
      if (line.startsWith("##") && line.slice(2).trim() && !/[+:]/.test(line.slice(2))) {
        selectors.push(line.slice(2)); continue
      }
      const exception = line.startsWith("@@")
      const value = exception ? line.slice(2) : line
      // Domain-scoped cosmetics, procedural selectors, options and regex rules
      // need semantics this bridge does not provide. Cosmetic exceptions mean
      // the list's cosmetics cannot safely be applied either.
      if (!value || value.includes("$") || value.includes("#") || value.startsWith("/")) {
        skipped++
        if (exception || value.includes("$badfilter")) unsafeException = true
        continue
      }
      try { (exception ? allowed : blocked).push(pattern(value)) } catch { skipped++ }
    }
    const cosmeticException = text.includes("#@#")
    return { blocked: unsafeException ? [] : blocked, allowed,
      selectors: cosmeticException ? [] : selectors, skipped }
  }
  return { parse }
})()
