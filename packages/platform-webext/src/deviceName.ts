/** What other devices call this browser until the user names it. */
export function deviceName(target: "chrome" | "firefox"): string {
  const browserName = target === "firefox" ? "Firefox" : "Chrome"
  const agent = navigator.userAgent
  const os = /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Android/.test(agent) ? "Android"
    : /CrOS/.test(agent) ? "ChromeOS" : /Linux/.test(agent) ? "Linux" : ""
  return os ? `${browserName} on ${os}` : browserName
}
