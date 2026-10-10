/** PDF viewers forbid content-script injection; render PDFs in our own reader page. */
export async function isPdfSource(url: string): Promise<boolean> {
  try {
    let response = await fetch(url, { method: "HEAD", credentials: "omit", signal: AbortSignal.timeout(5000) })
    if (response.status === 405 || response.status === 501 || !response.headers.get("content-type")) {
      response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(5000) })
    }
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    await response.body?.cancel()
    return type === "application/pdf" || (!type && /\.pdf$/i.test(new URL(url).pathname))
  } catch { return /\.pdf$/i.test(new URL(url).pathname) }
}
