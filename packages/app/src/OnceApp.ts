import { OnceClient, OncePlatformPorts } from "./types"
import { AppRuntime } from "./AppRuntime"

/**
 * Stable public application facade. Internal state and policy live in focused
 * collaborators composed by AppRuntime.
 */
export class OnceApp {
  readonly client: OnceClient
  private readonly runtime: AppRuntime

  constructor(platform: OncePlatformPorts) {
    this.runtime = new AppRuntime(platform)
    this.client = this.runtime.client
  }

  start(): Promise<void> {
    return this.runtime.start()
  }
}

export function createOnceApp(platform: OncePlatformPorts): OnceApp {
  return new OnceApp(platform)
}
