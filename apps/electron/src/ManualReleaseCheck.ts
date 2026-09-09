import { ElectronUpdateStatus } from "@once/platform-electron/bridge"

export const LATEST_RELEASE_PAGE = "https://github.com/batram/once/releases/latest"

export function manualReleaseStatus(): ElectronUpdateStatus {
  return {
    state: "idle", manual: true, releaseUrl: LATEST_RELEASE_PAGE,
    message: "Check GitHub for the latest release. Updates for this install are manual."
  }
}

export async function checkLatestRelease(
  version: string,
  request: (url: string, options?: RequestInit) => Promise<Response>
): Promise<ElectronUpdateStatus> {
  const fallback = manualReleaseStatus()
  try {
    const response = await request("https://api.github.com/repos/batram/once/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `Once/${version}` },
      signal: AbortSignal.timeout(15000),
      cache: "no-store"
    })
    if (!response.ok) {
      throw new Error(response.status === 404 ? "No published release was found." :
        `GitHub release check failed (HTTP ${response.status}).`)
    }
    const release = await response.json() as { tag_name?: unknown; draft?: boolean; prerelease?: boolean }
    if (typeof release.tag_name !== "string" || !release.tag_name.trim() ||
      release.tag_name.length > 200 || release.draft || release.prerelease) {
      throw new Error("GitHub returned an invalid release.")
    }
    return {
      ...fallback,
      message: `Latest release: ${release.tag_name}. Installed version: ${version}.`,
      releaseUrl: `https://github.com/batram/once/releases/tag/${encodeURIComponent(release.tag_name)}`
    }
  } catch (error) {
    return { ...fallback, state: "error", message: error instanceof Error ? error.message : "Release check failed." }
  }
}
