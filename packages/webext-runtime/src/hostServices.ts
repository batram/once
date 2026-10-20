// What a host supplies to the runtime. Electron answers these with Node and
// its session APIs (`@once/webext-runtime/node` has the Node halves); the
// Once Lite broker answers them from a WebView with Java behind it. Nothing
// in this package reaches a file system, a network stack or a cookie jar
// except through these.

/**
 * Synchronous read access to one unpacked extension. Synchronous because
 * content scripts are matched and read the moment a frame asks, before
 * its document exists, and that answer cannot wait.
 */
export interface ExtensionFileReader {
  /**
   * The file at an extension-relative path (already normalised: no leading
   * slash, no `.`/`..` segments), as text or bytes; null when there is no
   * such file.
   */
  read(relativePath: string): string | Uint8Array | null
}

/** One JSON document per name, read whole and replaced whole. */
export interface JsonStore {
  /**
   * The parsed document, or undefined when none was ever written. A
   * document that exists but cannot be read or parsed is an error.
   */
  read(name: string): Promise<unknown>
  /** Optional keyed object read; omitted keys are absent. Use with patch for lazy storage. */
  readKeys?(name: string, keys: string[]): Promise<Record<string, unknown>>
  /** Replaces the document so that a reader sees the old or the new one, never a torn one. */
  write(name: string, value: unknown): Promise<void>
  /**
   * Optional: sets and removes top-level keys of an object document already
   * on disk, so a large document is not written whole for one changed key.
   */
  patch?(name: string, set: Record<string, unknown>, remove: string[]): Promise<void>
}

/** A cookie as `browser.cookies` describes one. */
export interface WebExtCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: "no_restriction" | "lax" | "strict"
  session: boolean
  expirationDate?: number
  storeId: string
  firstPartyDomain: string
}

export interface CookieQuery {
  url?: string
  name?: string
  domain?: string
  path?: string
  secure?: boolean
  session?: boolean
}

export interface CookieSetDetails {
  url: string
  name?: string
  value?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: "no_restriction" | "lax" | "strict"
}

export interface CookieChange {
  removed: boolean
  cookie: WebExtCookie
  cause: "explicit" | "overwrite" | "expired" | "evicted"
}

/** The browser session's cookie jar, in WebExtension shapes. */
export interface CookieStore {
  get(query: CookieQuery): Promise<WebExtCookie[]>
  set(details: CookieSetDetails): Promise<void>
  remove(url: string, name: string): Promise<void>
  onChanged(listener: (change: CookieChange) => void): void
}

export type ExtensionPlatformOs = "win" | "mac" | "linux" | "android"

/** What `runtime.getPlatformInfo` and `i18n` answer about the host. */
export interface RuntimePlatform {
  /** The UI language, as `app.getLocale()` reports it on Electron. */
  locale(): string
  os: ExtensionPlatformOs
  /** `x86-64`, `x86-32`, `arm` or the host's own name for anything else. */
  arch: string
}

/** One entry of an XPI archive, read lazily. */
export interface ArchiveEntry {
  /** The path inside the archive, `/`-separated, directories with a trailing slash. */
  name: string
  isDirectory: boolean
  /** The declared uncompressed size. */
  size: number
  data(): Uint8Array
}

/** Where unpacked packages live: one directory per install, named by token. */
export interface ExtensionPackageStore {
  /** The directory a package named by `token` unpacks into; nothing is created yet. */
  directory(token: string): string
  mkdir(directory: string, relativePath: string): Promise<void>
  /** Creates missing parents and refuses to overwrite an existing file. */
  writeFile(directory: string, relativePath: string, data: Uint8Array): Promise<void>
  /** Removes the directory and everything in it; nothing to remove is fine. */
  remove(directory: string): Promise<void>
  /** Every entry of the packages root; empty when there is none yet. */
  list(): Promise<{ name: string; directory: string }[]>
  /** The form two directory strings are compared in. */
  canonical(directory: string): string
  reader(directory: string): ExtensionFileReader
}

/** What installing an extension from Mozilla Add-ons or a file needs. */
export interface ExtensionPackageHost {
  fetch(url: string, init: { credentials: "omit"; redirect: "manual"; signal: AbortSignal }): Promise<Response>
  /** Lower-case hex SHA-256 of the archive. */
  sha256(data: Uint8Array): Promise<string>
  unzip(archive: Uint8Array): ArchiveEntry[]
  /** The bytes of a file the user picked; `localFile` is whatever the picker returned. */
  readArchive(localFile: string): Promise<Uint8Array>
  locale(): string
  packages: ExtensionPackageStore
}
