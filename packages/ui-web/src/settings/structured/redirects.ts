export interface RedirectRow {
  match_url: string
  replace_url: string
  raw?: string
  invalid?: boolean
}

export function parseRedirectRows(text: string): RedirectRow[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((raw) => {
    const separator = raw.indexOf(" => ")
    if (separator < 1 || separator + 4 >= raw.length) {
      return { match_url: "", replace_url: "", raw, invalid: true }
    }
    return {
      match_url: raw.slice(0, separator).trim(),
      replace_url: raw.slice(separator + 4).trim()
    }
  })
}

export function serializeRedirectRows(rows: RedirectRow[]): string {
  return rows.map((row) => row.invalid
    ? row.raw || ""
    : `${row.match_url} => ${row.replace_url}`).join("\n")
}
