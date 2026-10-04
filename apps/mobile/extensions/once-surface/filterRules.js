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
      try {
        const rule = pattern(value)
        // Only index an actual hostname boundary. A bare ||example.com also
        // matches example.com.other, so it must stay in the fallback bucket.
        rule.onceDomain = /^\|\|([a-z0-9.-]+)(?=[/^]|\|$)/i.exec(value)?.[1].toLowerCase()
        ;(exception ? allowed : blocked).push(rule)
      } catch { skipped++ }
    }
    const cosmeticException = text.includes("#@#")
    return { blocked: unsafeException ? [] : blocked, allowed,
      selectors: cosmeticException ? [] : selectors, skipped }
  }
  function matcher(rules) {
    const domains = new Map(), fallback = []
    for (const rule of rules) {
      if (!rule.onceDomain) { fallback.push(rule); continue }
      const bucket = domains.get(rule.onceDomain) || []
      bucket.push(rule)
      domains.set(rule.onceDomain, bucket)
    }
    return url => {
      if (fallback.some(rule => rule.test(url))) return true
      if (!domains.size) return false
      let host
      try {
        const parsed = new URL(url)
        if (parsed.username || parsed.password) return rules.some(rule => rule.test(url))
        host = parsed.hostname.toLowerCase()
      } catch {
        // Preserve the parser's behavior for noncanonical callers as well.
        return rules.some(rule => rule.test(url))
      }
      for (;;) {
        if (domains.get(host)?.some(rule => rule.test(url))) return true
        const dot = host.indexOf(".")
        if (dot < 0) return false
        host = host.slice(dot + 1)
      }
    }
  }
  return { parse, matcher }
})()
