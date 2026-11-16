import { readFileSync } from "node:fs"
import path from "node:path"
import { WebContents } from "electron"
import { build_source, sanitize_selector_conf } from "@once/collectors/geny"
import { StorySource } from "@once/core"
import { TabEntry } from "./BrowserState"

/**
 * The isolated world the picker overlay runs in. Below the extension content
 * worlds (CONTENT_WORLD_BASE, 1000 and up) and apart from Electron's own 999.
 */
export const PICKER_WORLD_ID = 900

export class SourcePicker {
  start(entry: TabEntry): Promise<StorySource | null> {
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

  private async run(entry: TabEntry): Promise<StorySource | null> {
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
      // One evaluation in the picker's own world: the bundle installs the
      // starter there and the completion value is the starter's promise. The
      // page's world never holds the starter or the result, so a page that
      // defines `__onceSourcePicker` itself changes nothing.
      return await contents.executeJavaScriptInIsolatedWorld(
        PICKER_WORLD_ID,
        // The bundle may end in a line comment, so the call starts a new line.
        [{ code: `${pickerInjectionSource()}\n;window.__onceSourcePicker()` }],
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
