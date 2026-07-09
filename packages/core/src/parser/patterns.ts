export function patternMatches(url: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*")) {
      const split = pattern.split("*")
      if (split.length != 2) {
        throw new Error("For now only one wildcard * is allowed in pattern")
      }

      if (url.startsWith(split[0]) && url.endsWith(split[1])) {
        return true
      }
    }
    if (url.startsWith(pattern)) {
      return true
    }
  }

  return false
}
