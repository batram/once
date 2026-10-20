import type { InAppBrowserSurface } from "@once/platform-mobile"

/**
 * The shell can show saved content before extensions finish starting. Hold
 * its first navigations until both filter lists and userscripts are applied.
 * Each tab keeps its own cancellation and current layout while it waits.
 */
export function gateBrowserStartup(surface: InAppBrowserSurface): { release(): void; fail(error: unknown): void } {
  let release!: () => void
  let fail!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
  // Startup can fail without anyone having tried to open a page.
  void ready.catch(() => undefined)
  const gate = (page: InAppBrowserSurface): InAppBrowserSurface => {
    let sequence = 0
    let boundsVersion = 0
    let visibilityVersion = 0
    let bounds: Parameters<InAppBrowserSurface["setBounds"]>[0] | undefined
    let visibility: { visible: boolean; covered?: boolean } | undefined
    const open = page.open.bind(page)
    const navigate = page.navigate.bind(page)
    const close = page.close.bind(page)
    const setBounds = page.setBounds.bind(page)
    const setVisible = page.setVisible.bind(page)
    const forTab = page.forTab?.bind(page)
    const run = async (work: () => Promise<void>): Promise<void> => {
      const request = ++sequence
      await ready
      if (request === sequence) await work()
    }
    page.open = (options) => {
      const layout = boundsVersion
      const shown = visibilityVersion
      return run(() => open({
        ...options,
        ...(layout !== boundsVersion && bounds ? { bounds } : {}),
        ...(shown !== visibilityVersion && visibility ? { visible: visibility.visible && !visibility.covered } : {})
      }))
    }
    page.navigate = (url) => run(() => navigate(url))
    page.close = () => {
      sequence++
      return close()
    }
    page.setBounds = (value) => { bounds = value; boundsVersion++; return setBounds(value) }
    page.setVisible = (visible, covered) => {
      visibility = { visible, covered }
      visibilityVersion++
      return setVisible(visible, covered)
    }
    if (forTab) page.forTab = (identity) => gate(forTab(identity))
    return page
  }
  gate(surface)
  return { release, fail }
}
