import { DEFAULT_AUTH_HEADER, StorySource, StorySourceAuth } from "@once/core"
import { SecretStorePort } from "./types"

/**
 * Where a source's token lives in the device's secret store. Keyed on the
 * source id, which is permanent, so editing the URL keeps the token; keyed
 * per source rather than per host, so two sources for one site can differ.
 */
export function sourceSecretKey(sourceId: string): string {
  return `source:${sourceId}`
}

/** A source whose token has to come from somewhere before it can be fetched. */
export function needsSourceSecret(source: Pick<StorySource, "auth">): boolean {
  return source.auth?.kind === "token"
}

/**
 * What the fetch has to carry for the source to be recognised. Session auth
 * asks the shell to send its cookies; token auth puts the stored secret in
 * the header the source named. No auth means an anonymous request, which is
 * also what an anonymous request has always looked like.
 */
export function sourceRequestInit(
  auth: StorySourceAuth | undefined,
  secret: string
): RequestInit | undefined {
  if (!auth) return undefined
  if (auth.kind === "session") return { credentials: "include" }
  return { headers: { [auth.header ?? DEFAULT_AUTH_HEADER]: secret } }
}

/**
 * Reads the token a source needs, and says clearly when it is not there: a
 * token source with nothing stored is a configuration problem the user can
 * fix, not a network failure to retry.
 */
export async function readSourceSecret(
  secrets: SecretStorePort | undefined,
  source: Pick<StorySource, "id" | "auth">
): Promise<string> {
  if (!needsSourceSecret(source)) return ""
  if (!secrets) throw new Error("No token: this shell has nowhere to keep one")
  const secret = await secrets.get(sourceSecretKey(source.id))
  if (!secret) throw new Error("No token: none is stored for this source on this device")
  return secret
}
