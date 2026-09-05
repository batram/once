import { HostToSandbox, SANDBOX_LIMITS, SANDBOX_TIMEOUTS } from "@once/core"
import { AddonSandboxSession, SandboxHostOperations } from "./AddonSandboxSession"

export type AddonRunState = "idle" | "starting" | "running" | "failed" | "disabled" | "disposed"

/** Owns readiness and failure counts across disposable frame/session pairs. */
export class AddonSandbox {
  private frame: HTMLIFrameElement | null = null
  private session: AddonSandboxSession | null = null
  private starting: Promise<AddonSandboxSession> | null = null
  private cancelStart: (() => void) | null = null
  private failures = 0
  private state: AddonRunState = "idle"
  private readonly onMessage = (event: MessageEvent): void => {
    if (this.frame && event.source === this.frame.contentWindow) this.session?.receive(event.data)
  }

  constructor(
    private readonly addonId: string,
    private readonly pageUrl: string,
    private readonly code: string,
    private readonly settings: () => Readonly<Record<string, unknown>>,
    private readonly host: SandboxHostOperations,
    private readonly changed: (state: AddonRunState, error?: string) => void = () => undefined
  ) {}

  ensure(): Promise<AddonSandboxSession> {
    if (this.state === "disposed" || this.state === "disabled") {
      return Promise.reject(new Error(`Add-on ${this.addonId} is ${this.state}`))
    }
    if (this.starting) return this.starting
    if (this.state === "running" && this.session) return Promise.resolve(this.session)
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  updateSettings(): void {
    if (this.state === "failed" || this.state === "disabled") {
      this.failures = 0
      this.setState("idle")
    }
    if (this.state === "running") this.session?.settings(this.settings())
  }

  dispose(): void {
    this.setState("disposed")
    this.cancelStart?.()
    this.session?.dispose()
    this.session = null
    this.removeFrame()
  }

  private setState(state: AddonRunState, error?: string): void {
    this.state = state
    this.changed(state, error)
  }

  private failed(reason: string): void {
    if (this.state === "disposed" || this.state === "failed" || this.state === "disabled") return
    this.failures += 1
    this.session?.dispose()
    this.session = null
    this.removeFrame()
    this.setState(this.failures >= SANDBOX_LIMITS.failures ? "disabled" : "failed", reason)
  }

  private async start(): Promise<AddonSandboxSession> {
    this.setState("starting")
    const frame = document.createElement("iframe")
    frame.setAttribute("sandbox", "allow-scripts")
    frame.hidden = true
    frame.title = `Add-on sandbox: ${this.addonId}`
    frame.dataset.addonSandbox = this.addonId
    this.frame = frame
    const session = new AddonSandboxSession(this.addonId, {
      post: (message: HostToSandbox) => frame.contentWindow?.postMessage(message, "*"),
      destroy: () => this.removeFrame(),
      failed: (reason) => this.failed(reason)
    }, this.host)
    this.session = session
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Add-on did not start in time")), SANDBOX_TIMEOUTS.loadMs)
      this.cancelStart = () => reject(new Error("Add-on sandbox closed"))
    })
    const loaded = new Promise<void>((resolve, reject) => {
      frame.addEventListener("load", () => resolve(), { once: true })
      frame.addEventListener("error", () => reject(new Error("Sandbox page failed to load")), { once: true })
    })
    window.addEventListener("message", this.onMessage)
    frame.src = this.pageUrl
    document.body.append(frame)
    try {
      await Promise.race([loaded, deadline])
      await Promise.race([session.load(this.code, this.settings()), deadline])
      if (this.session !== session) throw new Error("Add-on sandbox closed")
      this.setState("running")
      session.settings(this.settings())
      return session
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      clearTimeout(timer)
      this.cancelStart = null
    }
  }

  private removeFrame(): void {
    window.removeEventListener("message", this.onMessage)
    this.frame?.remove()
    this.frame = null
  }
}
