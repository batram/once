import browser = require("webextension-polyfill")

import { createOnceApp } from "@once/app"
import {
  describeStoryMenu,
  executeStoryMenuAction,
  mountOnceUi,
  storyFromTarget,
  StoryListItem,
  StoryMenuActionId
} from "@once/ui-web"
import { createWebExtPlatform } from "@once/platform-webext"
import { isStoryMenuActionForContext } from "./storyMenuBackground"

declare const __ONCE_WEBEXT_TARGET__: "chrome" | "firefox"
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string

document.addEventListener("DOMContentLoaded", async () => {
  document.body.dataset.platform = "webext"
  document.body.dataset.webextTarget = __ONCE_WEBEXT_TARGET__
  const storyMenuContextId = crypto.randomUUID()
  const platform = createWebExtPlatform(browser)
  const testMode = new URLSearchParams(window.location.search).has("once-e2e")
  if (testMode) {
    const state = await browser.storage.local.get("onceE2ESeeded")
    if (!state.onceE2ESeeded) {
      await platform.listStore.set("story_sources", [])
      await browser.storage.local.set({ onceE2ESeeded: true })
    }
  }
  const app = createOnceApp(platform)
  const client = app.client

  await app.start()
  await mountOnceUi(client, {
    appVersion: browser.runtime.getManifest().version,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
    showHoveredLinks: __ONCE_WEBEXT_TARGET__ === "chrome",
    initialStoryLoad: testMode ? "disabled" : "network"
  })
  let lastStory: StoryListItem | undefined
  let lastContextAt = 0
  document.addEventListener("contextmenu", (event) => {
    const story = storyFromTarget(event.target)
    const onStoryList = Boolean(
      story || (event.target as Element | null)?.closest(".stories_container")
    )
    if (!onStoryList) return
    lastStory = story
    lastContextAt = Date.now()
    const items = describeStoryMenu({
      platform: __ONCE_WEBEXT_TARGET__,
      buildChannel: __ONCE_BUILD_CHANNEL__,
      story
    })
    void browser.runtime.sendMessage({
      onceCommand: "story-menu-context",
      contextId: storyMenuContextId,
      items
    })
    if (__ONCE_WEBEXT_TARGET__ === "firefox") {
      const menus = browser.menus as unknown as {
        overrideContext(options: { showDefaults: boolean }): void
      }
      menus.overrideContext({ showDefaults: false })
    }
  }, true)

  browser.runtime.onMessage.addListener((message: {
    onceCommand?: string
    action?: StoryMenuActionId
    contextId?: string
    targetElementId?: number
  }) => {
    if (
      !isStoryMenuActionForContext(message, storyMenuContextId) ||
      !message.action
    ) return
    const menus = browser.menus as unknown as {
      getTargetElement?(id: number): Element | null
    }
    const target = message.targetElementId === undefined
      ? null
      : menus.getTargetElement?.(message.targetElementId)
    const story = storyFromTarget(target ?? null) ||
      (Date.now() - lastContextAt < 10_000 ? lastStory : undefined)
    void executeStoryMenuAction(message.action, story)
  })
  document.body.dataset.onceReady = "true"
})
