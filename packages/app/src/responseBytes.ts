/** Bound streamed input before passing untrusted bytes to a document decoder. */
export async function readResponseBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) throw new Error(`${label} too large`)
  if (!response.body) throw new Error(`${label} unavailable`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error(`${label} too large`)
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
