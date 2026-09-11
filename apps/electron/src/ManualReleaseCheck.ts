import { ElectronUpdateStatus } from "@once/platform-electron/bridge"

export const LATEST_RELEASE_PAGE = "https://github.com/batram/once/releases/latest"

/** @param reason why this install has no automatic updates, kept in front of the hint. */
export function manualReleaseStatus(reason?: string): ElectronUpdateStatus {
  return {
    state: "idle", manual: true, releaseUrl: LATEST_RELEASE_PAGE,
    message: `${reason ? `${reason} ` : ""}Check GitHub for the latest release. Updates for this install are manual.`
  }
}

function releaseNumbers(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

/** Positive when `tag` is newer than `version`, zero when equal, null when either is not X.Y.Z. */
function compareRelease(tag: string, version: string): number | null {
  const latest = releaseNumbers(tag)
  const installed = releaseNumbers(version)
  if (!latest || !installed) return null
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== installed[index]) return latest[index] - installed[index]
  }
  return 0
}

function releaseVerdict(tag: string, version: string): string {
  const order = compareRelease(tag, version)
  if (order !== null && order > 0) return `A newer release is available: ${tag}. Installed version: ${version}.`
  if (order === 0) return `This is the latest release (${tag}).`
  // A dev build ahead of the published release, or a tag that is not X.Y.Z.
  return `Latest release: ${tag}. Installed version: ${version}.`
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
        response.status === 403 || response.status === 429
          ? "GitHub is rate limiting release checks from this network right now. Open the release page instead."
          : `GitHub release check failed (HTTP ${response.status}).`)
    }
    const release = await response.json() as { tag_name?: unknown; draft?: boolean; prerelease?: boolean }
    if (typeof release.tag_name !== "string" || !release.tag_name.trim() ||
      release.tag_name.length > 200 || release.draft || release.prerelease) {
      throw new Error("GitHub returned an invalid release.")
    }
    return {
      ...fallback,
      message: releaseVerdict(release.tag_name, version),
      releaseUrl: `https://github.com/batram/once/releases/tag/${encodeURIComponent(release.tag_name)}`
    }
  } catch (error) {
    return { ...fallback, state: "error", message: error instanceof Error ? error.message : "Release check failed." }
  }
}
