// Text and bytes conversions the runtime needs without Node's Buffer.

const decoder = new TextDecoder()

export function asText(value: string | Uint8Array): string {
  return typeof value === "string" ? value : decoder.decode(value)
}

export function asBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ""
  // Chunked: a spread of a multi-megabyte array overflows the call stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
