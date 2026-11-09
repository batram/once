/** Bytes a native plugin handed over as base64, the only binary form its bridge carries. */
export function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
