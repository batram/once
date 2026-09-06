import { StoryView } from "./storyView"
import { AddonRequest, AddonResponse } from "./connections"
import { AddonStoryContent, AddonTrayEvent, AddonTrayView } from "./trayProtocol"

export interface AddonTrayContext {
  readonly signal: AbortSignal
  request(connectionId: string, request: AddonRequest): Promise<AddonResponse>
  getStoryContent(): Promise<AddonStoryContent>
}

export interface AddonCollectorHandlers {
  parse(body: string | Record<string, unknown>, context: { url: string; config: unknown }): unknown
  globalSearch?(needle: string): unknown
  domainSearch?(needle: string): unknown
}

export interface AddonFetchResult { status: number; text: string }

/** Public author contract; handlers may return promises. Keep the supplied story object for operations. */
export interface OnceAddonApi {
  readonly settings: Readonly<Record<string, unknown>>
  readonly collectors: { register(id: string, handlers: AddonCollectorHandlers): void }
  readonly storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
  fetch(url: string): Promise<AddonFetchResult>
  /** Pass a tray context to tie cancellation to that particular invocation. */
  request(connectionId: string, request: AddonRequest, context?: AddonTrayContext): Promise<AddonResponse>
  getStoryContent(story: StoryView): Promise<AddonStoryContent>
  onTray(handler: (tray: string, event: AddonTrayEvent, story: StoryView, context: AddonTrayContext) => AddonTrayView | Promise<AddonTrayView>): void
  onInvoke(handler: (action: string, story: StoryView) => unknown): void
  onPanel(handler: (action: string) => unknown): void
  onBadges(handler: (contribution: string, stories: readonly StoryView[]) => unknown): void
  onSettings(handler: (settings: Readonly<Record<string, unknown>>) => void): void
  openUrl(story: StoryView, url: string, target?: "_self" | "blank" | "middle"): void
  copyText(story: StoryView, text: string): void
  search(story: StoryView, query: string): void
  notify(story: StoryView, text: string): void
  setReadState(story: StoryView, state: "unread" | "read" | "skipped"): void
  toggleBookmark(story: StoryView): void
  addTag(story: StoryView, tag: string): void
  updateBadge(story: StoryView, contribution: string, text: string): void
}
