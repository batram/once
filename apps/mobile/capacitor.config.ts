import type { CapacitorConfig } from "@capacitor/cli"
import { KeyboardResize } from "@capacitor/keyboard"

export type MobileBuildChannel = "dev" | "release"

export function mobileBuildChannel(
  value = process.env.ONCE_BUILD_CHANNEL
): MobileBuildChannel {
  if (!value) return "dev"
  if (value !== "dev" && value !== "release") {
    throw new Error(`ONCE_BUILD_CHANNEL must be dev or release (received ${value})`)
  }
  return value
}

export function createCapacitorConfig(
  channel = mobileBuildChannel()
): CapacitorConfig {
  const dev = channel === "dev"
  return {
    appId: dev ? "com.zmarn.once.dev" : "com.zmarn.once",
    appName: dev ? "Once Dev" : "Once",
    webDir: "dist",
    android: {
      flavor: dev ? "development" : "production",
      allowMixedContent: dev
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
      SplashScreen: {
        launchAutoHide: true,
        backgroundColor: dev ? "#342b20" : "#ffffff"
      }
    }
  }
}

export default createCapacitorConfig()
