import { readFileSync } from "node:fs"
import path from "node:path"
import { WebContents } from "electron"
import { build_source, sanitize_selector_conf } from "@once/collectors/geny"
import { TabEntry } from "./BrowserState"

export class SourcePicker {
  start(entry: TabEntry): Promise<string | null> {
    if (entry.pickerSession) return entry.pickerSession
    const url = entry.view.webContents.getURL()
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("Source picking needs an HTTP or HTTPS page")
    }
    entry.pickerSession = this.run(entry).finally(() => {
      entry.pickerSession = null
    })
    return entry.pickerSession
  }

  private async run(entry: TabEntry): Promise<string | null> {
    const contents = entry.view.webContents
    let cleanup = (): void => undefined
    const cancelled = new Promise<null>((resolve) => {
      const cancel = () => resolve(null)
      const onNavigation = (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
      ) => {
        if (event.isMainFrame && !event.isSameDocument) cancel()
      }
      contents.on("did-start-navigation", onNavigation)
      contents.once("destroyed", cancel)
      cleanup = () => {
        contents.removeListener("did-start-navigation", onNavigation)
        contents.removeListener("destroyed", cancel)
      }
    })

    try {
      const execution = this.execute(contents)
      execution.catch((): void => undefined)
      const conf = await Promise.race([cancelled, execution])
      if (conf == null || contents.isDestroyed()) return null
      if (typeof conf !== "string" || conf.length > 10_000) {
        throw new Error("The source picker returned an invalid result")
      }
      const sanitized = sanitize_selector_conf(JSON.parse(conf))
      return build_source(sanitized, contents.getURL())
    } catch (error) {
      if (contents.isDestroyed()) return null
      throw error
    } finally {
      cleanup()
    }
  }

  private async execute(contents: WebContents): Promise<unknown> {
    try {
      await contents.executeJavaScript(pickerInjectionSource(), true)
      return await contents.executeJavaScript(
        "window.__onceSourcePicker ? window.__onceSourcePicker() : null",
        true
      )
    } catch (error) {
      if (contents.isDestroyed()) return null
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`The source picker could not run on this page: ${detail}`)
    }
  }
}

let pickerInjectionBundle: string | null = null

function pickerInjectionSource(): string {
  pickerInjectionBundle ??= readFileSync(
    path.join(__dirname, "picker-injection.js"),
    "utf8"
  )
  return pickerInjectionBundle
}
