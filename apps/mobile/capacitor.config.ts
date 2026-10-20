import type { CapacitorConfig } from "@capacitor/cli"
import { KeyboardResize } from "@capacitor/keyboard"

export type MobileBuildChannel = "dev" | "release"
/** The Android browsing engine: GeckoView, or Once Lite's system WebView (docs/plans/once-lite-plan.md). */
export type MobileEngine = "gecko" | "lite"

export function mobileBuildChannel(
  value = process.env.ONCE_BUILD_CHANNEL
): MobileBuildChannel {
  if (!value) return "dev"
  if (value !== "dev" && value !== "release") {
    throw new Error(`ONCE_BUILD_CHANNEL must be dev or release (received ${value})`)
  }
  return value
}

export function mobileEngine(value = process.env.ONCE_MOBILE_ENGINE): MobileEngine {
  if (!value) return "gecko"
  if (value !== "gecko" && value !== "lite") {
    throw new Error(`ONCE_MOBILE_ENGINE must be gecko or lite (received ${value})`)
  }
  return value
}

/** Android identity per engine and channel: com.zmarn.once[.lite][.dev], "Once[ Lite][ Dev]". */
export function androidIdentity(engine: MobileEngine, channel: MobileBuildChannel): {
  appId: string
  appName: string
  flavor: string
} {
  const dev = channel === "dev"
  const lite = engine === "lite"
  return {
    appId: `com.zmarn.once${lite ? ".lite" : ""}${dev ? ".dev" : ""}`,
    appName: `Once${lite ? " Lite" : ""}${dev ? " Dev" : ""}`,
    flavor: `${engine}${dev ? "Development" : "Production"}`
  }
}

export function createCapacitorConfig(
  channel = mobileBuildChannel(),
  engine = mobileEngine()
): CapacitorConfig {
  const dev = channel === "dev"
  const identity = androidIdentity(engine, channel)
  return {
    // iOS has one engine (WebKit); the Android identity follows the engine flavour.
    appId: identity.appId,
    appName: identity.appName,
    webDir: "dist",
    android: {
      flavor: identity.flavor,
      allowMixedContent: dev,
      // Capacitor's logging prints every plugin call and result whole, sync
      // requests with their authorization header among them, in any
      // debuggable build. RedactingChromeClient forwards the console instead.
      loggingBehavior: "none"
    },
    ios: {
      scheme: dev ? "Once Dev" : "Once"
    },
    plugins: {
      // Off: enabling it patches fetch through a same-origin proxy path the
      // web view also serves to <script> and workers, so `script-src 'self'`
      // would admit any script on the web. Cross-origin requests go through
      // CapacitorHttp.request instead (platform-mobile's nativeFetch).
      CapacitorHttp: { enabled: false },
      // The web view shrinks above the keyboard, so bars along the bottom
      // (find in page) stay in view and the page is not scrolled away. The
      // window behind it takes the body's background, so the strip above the
      // keyboard matches the active theme instead of showing black.
      Keyboard: { resize: KeyboardResize.Native, autoBackdropColor: "dom" },
      // The shell's viewport always covers the bars. Saying so from the start
      // keeps SystemBars' padding equal to Android's KeyboardSpace, which owns
      // it, before the first page has reported its viewport.
      SystemBars: { initialViewportFitValueHint: "cover" },
      SplashScreen: {
        launchAutoHide: true,
        backgroundColor: dev ? "#342b20" : "#ffffff"
      }
    }
  }
}

export default createCapacitorConfig()
