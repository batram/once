import { HostToSandbox } from "@once/core"
import { AddonSandboxSession, SandboxHostOperations } from "./AddonSandboxSession"

/**
 * The frame half of an add-on sandbox: a hidden `<iframe sandbox>` on an
 * opaque origin, loading the static sandbox page the platform serves, with
 * the session speaking to it over postMessage. Created lazily on the first
 * request and rebuilt after a crash; `sandbox="allow-scripts"` and nothing
 * more is the whole grant.
 */
export class AddonSandbox {
  private frame: HTMLIFrameElement | null = null
  private session: AddonSandboxSession | null = null
  private starting: Promise<AddonSandboxSession> | null = null
  private readonly onMessage = (event: MessageEvent): void => {
    if (!this.frame || event.source !== this.frame.contentWindow) return
    this.session?.receive(event.data)
  }

  constructor(
    private readonly addonId: string,
    private readonly pageUrl: string,
    private readonly code: string,
    private readonly settings: () => Readonly<Record<string, unknown>>,
    private readonly host: SandboxHostOperations
  ) {}

  /** The running session, starting the frame and the script when needed. */
  ensure(): Promise<AddonSandboxSession> {
    if (this.session && !this.session.disabled) return Promise.resolve(this.session)
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  dispose(): void {
    this.session?.dispose()
    this.session = null
    this.removeFrame()
  }

  private async start(): Promise<AddonSandboxSession> {
    if (this.session?.disabled) throw new Error(`Add-on ${this.addonId} is switched off after repeated failures`)
    const frame = document.createElement("iframe")
    frame.setAttribute("sandbox", "allow-scripts")
    frame.hidden = true
    frame.title = `Add-on sandbox: ${this.addonId}`
    frame.dataset.addonSandbox = this.addonId
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener("load", () => resolve(), { once: true })
      frame.addEventListener("error", () => reject(new Error("sandbox page failed to load")), { once: true })
    })
    frame.src = this.pageUrl
    window.addEventListener("message", this.onMessage)
    document.body.append(frame)
    this.frame = frame

    const session = new AddonSandboxSession(this.addonId, {
      post: (message: HostToSandbox) => frame.contentWindow?.postMessage(message, "*"),
      destroy: () => this.removeFrame()
    }, this.host)
    this.session = session
    await loaded
    await session.load(this.code, this.settings())
    return session
  }

  private removeFrame(): void {
    window.removeEventListener("message", this.onMessage)
    this.frame?.remove()
    this.frame = null
  }
}
