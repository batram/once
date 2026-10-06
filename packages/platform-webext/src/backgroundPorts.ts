// What an extension background needs of this package, without the PouchDB
// platform the panel builds: device-local and browser-synced storage, Firefox
// consent, and the default device name.
export { deviceName } from "./deviceName"
export { WebExtSecretStorage } from "./storage/WebExtSecretStorage"
export { WebExtSyncStorage } from "./storage/WebExtSyncStorage"
export { createFirefoxSyncConsent } from "./storage/WebExtSyncConsent"
export { createWebExtTabOpener } from "./webextPorts"
