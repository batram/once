import { App } from "@capacitor/app"
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from "@capacitor/barcode-scanner"
import { Capacitor } from "@capacitor/core"
import { openPairingLink } from "@once/ui-web"

/** Scans the pairing code another device shows; null when cancelled or nothing was read. */
async function scanPairingCode(): Promise<string | null> {
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: "Point the camera at the pairing code shown on your other device",
      scanButton: false
    })
    return result.ScanResult || null
  } catch (error) {
    // Closing the scanner is reported as an error; it is a choice, not a failure.
    if (/cancel/i.test(String((error as { message?: unknown })?.message ?? error))) return null
    throw error
  }
}

/**
 * Pairing on this device: listens for pairing links opened from outside
 * (the system camera reading a code, a link tapped in a message), and
 * returns the in-app scanner for Settings › Sync. Each link asks before it
 * connects. A link that launched the app waits for Settings to exist.
 */
export function setUpPairing(): (() => Promise<string | null>) | undefined {
  if (!Capacitor.isNativePlatform()) return undefined
  const open = (url: string | undefined, attempt = 0) => {
    if (!url?.startsWith("once://pair?")) return
    if (document.body.dataset.onceReady === "true") openPairingLink(url)
    else if (attempt < 60) setTimeout(() => open(url, attempt + 1), 500)
  }
  void App.addListener("appUrlOpen", ({ url }) => open(url))
  void App.getLaunchUrl().then((launch) => open(launch?.url)).catch(() => undefined)
  return scanPairingCode
}
