import { build_source, sanitize_selector_conf } from "@once/collectors/geny"
import type { InAppBrowserSurface } from "@once/platform-mobile"

const START_PICKER_SCRIPT =
  "window.__oncePickerResult=undefined;" +
  "window.__onceSourcePicker().then(function(value){" +
  "window.__oncePickerResult=JSON.stringify(value)})"
const READ_PICKER_RESULT_SCRIPT =
  "window.__oncePickerResult===undefined?null:window.__oncePickerResult"

export interface MobileSourcePickerOptions {
  surface: InAppBrowserSurface
  openBrowserUrl: (url: string) => void
  activateSurface: () => void
  loadInjection: () => Promise<string>
  pollDelayMs?: number
  pollAttempts?: number
  delay?: (milliseconds: number) => Promise<void>
}

export class MobileSourcePicker {
  private readonly options: MobileSourcePickerOptions
  private currentUrl = ""
  private readonly pollDelayMs: number
  private readonly pollAttempts: number
  private readonly delay: (milliseconds: number) => Promise<void>

  constructor(options: MobileSourcePickerOptions) {
    this.options = options
    this.pollDelayMs = options.pollDelayMs ?? 100
    this.pollAttempts = options.pollAttempts ?? 1800
    this.delay = options.delay ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async install(): Promise<void> {
    await this.options.surface.addListener("navigationCommitted", ({ url }) => {
      this.currentUrl = url
    })
  }

  async pick(
    requestedUrl: string | undefined
  ): Promise<ReturnType<typeof build_source> | null> {
    if (!this.options.surface.available) {
      throw new Error("There is no active tab to pick from")
    }
    if (requestedUrl) {
      await this.navigate(requestedUrl)
    } else if (!/^https?:\/\//i.test(this.currentUrl)) {
      throw new Error("There is no active tab to pick from")
    }

    this.options.activateSurface()
    await this.options.surface.setVisible(true)
    await this.options.surface.evaluateJavaScript(await this.options.loadInjection())
    await this.options.surface.evaluateJavaScript(START_PICKER_SCRIPT)
    const result = await this.pollResult()
    if (result === null) return null
    return build_source(
      sanitize_selector_conf(JSON.parse(result)),
      this.currentUrl
    )
  }

  private async navigate(url: string): Promise<void> {
    let removeFinished = (): void => undefined
    let removeFailed = (): void => undefined
    const cleanup = (): void => {
      removeFinished()
      removeFailed()
    }
    let resolveFinished = (): void => undefined
    let rejectFinished = (_error: Error): void => undefined
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve
      rejectFinished = reject
    })
    try {
      removeFinished = await this.options.surface.addListener(
        "navigationFinished",
        () => {
          cleanup()
          resolveFinished()
        }
      )
      removeFailed = await this.options.surface.addListener(
        "navigationFailed",
        ({ message }) => {
          cleanup()
          rejectFinished(new Error(`The page could not be loaded: ${message}`))
        }
      )
      this.options.openBrowserUrl(url)
    } catch (error) {
      cleanup()
      throw error
    }
    await finished
  }

  private async pollResult(): Promise<string | null> {
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      await this.delay(this.pollDelayMs)
      const value = await this.options.surface.evaluateJavaScript(
        READ_PICKER_RESULT_SCRIPT
      )
      if (value && value !== "null") return decodePickerResult(value)
    }
    throw new Error("The source picker timed out")
  }
}

export function decodePickerResult(value: string): string | null {
  const decoded: unknown = JSON.parse(value)
  if (typeof decoded !== "string") {
    throw new Error("The source picker returned a malformed result")
  }
  const result: unknown = JSON.parse(decoded)
  if (result !== null && typeof result !== "string") {
    throw new Error("The source picker returned a malformed result")
  }
  return result
}

export function loadMobilePickerInjection(): Promise<string> {
  return fetch(new URL("picker-injection.js", document.baseURI)).then((response) => {
    if (!response.ok) {
      throw new Error("The source picker bundle could not be loaded")
    }
    return response.text()
  })
}
