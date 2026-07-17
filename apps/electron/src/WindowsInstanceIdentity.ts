import { createHash } from "node:crypto"
import path from "node:path"

export interface WindowsInstanceIdentityOptions {
  buildChannel: "release" | "dev"
  executablePath: string
  isPackaged: boolean
  platform: NodeJS.Platform
  squirrelUpdateExists: boolean
  userDataPath: string
}

export interface WindowsInstanceIdentity {
  appUserModelId: string
  userDataPath: string
}

export function installedAppUserModelId(
  buildChannel: "release" | "dev"
): string {
  return buildChannel === "dev"
    ? "com.squirrel.oncedev.once-dev"
    : "com.squirrel.once.once"
}

/**
 * Give each unpacked/ZIP distribution its own Chromium and Once profile.
 * Squirrel installations already have stable, channel-specific identities and
 * must retain the historical userData path across version-directory changes.
 */
export function windowsInstanceIdentity(
  options: WindowsInstanceIdentityOptions
): WindowsInstanceIdentity | null {
  if (options.platform !== "win32" || !options.isPackaged ||
    options.squirrelUpdateExists) {
    return null
  }

  // Windows paths are case-insensitive. The containing directory identifies a
  // distribution, so replacing/renaming its executable does not lose its data.
  const installationDirectory = path.win32
    .resolve(path.win32.dirname(options.executablePath))
    .toLocaleLowerCase("en-US")
  const id = createHash("sha256")
    .update(installationDirectory)
    .digest("hex")
    .slice(0, 16)

  return {
    appUserModelId: `com.once.${options.buildChannel}.${id}`,
    userDataPath: path.win32.join(options.userDataPath, "instances", id)
  }
}
