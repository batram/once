import { Session } from "electron"
import {
  EXTENSION_SCHEME,
  ExtensionLookup,
  ExtensionProtocolOptions,
  serveExtensionRequest
} from "@once/webext-runtime"

/** Serves `moz-extension://<host>/<path>` from the extension's directory. */
const configuredSessions = new WeakSet<Session>()

export function configureExtensionProtocol(
  targetSession: Session,
  lookup: ExtensionLookup,
  options: ExtensionProtocolOptions = {}
): void {
  if (configuredSessions.has(targetSession)) targetSession.protocol.unhandle(EXTENSION_SCHEME)
  targetSession.protocol.handle(EXTENSION_SCHEME, (request) =>
    serveExtensionRequest(request.url, lookup, options)
  )
  configuredSessions.add(targetSession)
}
