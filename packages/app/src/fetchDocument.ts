export async function fetchDocument(
  fetch: typeof globalThis.fetch,
  url: string
): Promise<{ html: string; url: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader mode only supports HTTP and HTTPS pages")
  }
  const response = await fetch(parsed.toString(), { credentials: "omit" })
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "The site rate-limited the reader request (HTTP 429). Try again later or open the original page."
      )
    }
    const detail = response.statusText ? `: ${response.statusText}` : ""
    throw new Error(
      `The reader request failed with HTTP ${response.status}${detail}`
    )
  }
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(
      `Reader mode cannot display ${contentType || "this content type"}`
    )
  }
  return { html: await response.text(), url: response.url || parsed.toString() }
}
