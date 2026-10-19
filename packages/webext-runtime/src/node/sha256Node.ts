import { createHash } from "node:crypto"

/** Node's SHA-256, for archives too large to hash in plain JavaScript. */
export async function sha256Node(data: Uint8Array): Promise<string> {
  return createHash("sha256").update(data).digest("hex")
}
