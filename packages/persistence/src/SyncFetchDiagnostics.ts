const requests = new WeakMap<object, Record<string, unknown>>()
const requestProperty = "__onceSyncRequestDetails"
const knownContexts = new WeakSet<object>()

/** Keep request metadata beside the original error; never capture headers or bodies. */
export function syncFetchDiagnostics(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const started = Date.now()
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input))
    const endpoint = url.pathname.split("/").find(part => part.startsWith("_")) ?? "database/document"
    const context = {
      origin: url.origin,
      endpoint,
      method: init?.method ?? request?.method ?? "GET"
    }
    const remember = (error: unknown, stage: "fetch" | "response body", response?: Response) => {
      if (error && typeof error === "object") {
        const contextDetails = {
          ...context,
          stage,
          status: response?.status,
          contentLength: response?.headers.get("content-length") ?? undefined,
          contentEncoding: response?.headers.get("content-encoding") ?? undefined,
          elapsedMs: Date.now() - started,
          aborted: init?.signal?.aborted ?? request?.signal.aborted ?? false,
          online: typeof navigator === "undefined" ? undefined : navigator.onLine
        }
        requests.set(error, contextDetails)
        knownContexts.add(contextDetails)
        // PouchDB copies own string properties when normalizing replication
        // and changes-feed errors. A WeakMap alone loses that association.
        try { Object.defineProperty(error, requestProperty, { value: contextDetails, configurable: true }) }
        catch { /* Non-extensible errors still retain their WeakMap context. */ }
      }
    }
    try {
      const response = await fetcher(input, init)
      // Fetch resolves when headers arrive. PouchDB reads CouchDB responses
      // with json(), which can reject later if the body is truncated.
      const readJson = response.json.bind(response)
      response.json = async () => {
        try { return await readJson() }
        catch (error) { remember(error, "response body", response); throw error }
      }
      return response
    } catch (error) {
      remember(error, "fetch")
      throw error
    }
  }
}

export function syncRequestDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined
  const copied = (error as Record<string, unknown>)[requestProperty]
  return requests.get(error) ?? (copied && typeof copied === "object" && knownContexts.has(copied) ? copied as Record<string, unknown> : undefined)
}
