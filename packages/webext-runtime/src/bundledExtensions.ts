// The extensions Once ships: an explicit list, because every entry widens
// the browser.* surface the runtime has to honour. The bundles themselves
// come from scripts/fetch-extensions.js into vendor/extensions during
// development and travel with each app's packaging; where they end up on a
// device is the host's business.

export interface BundledExtension {
  /** The Firefox extension id the manifest must carry. */
  id: string
  /** Directory name under the vendor root. */
  directory: string
}

export const BUNDLED_EXTENSIONS: readonly BundledExtension[] = [
  { id: "uBlock0@raymondhill.net", directory: "ublock-origin" },
  { id: "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", directory: "violentmonkey" }
]

export interface BundledExtensionSource {
  id: string
  directory: string
  /** Missing on a development checkout that has not run the fetch yet. */
  present: boolean
}
