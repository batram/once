import browser = require("webextension-polyfill")

import { createOnceApp } from "@once/app"
import type { BrowserManagedShortcut, BundledAddonFiles } from "@once/ui-web"
import {
  describeStoryMenu,
  executeStoryMenuAction,
  getKeyboardDispatcher,
  mountOnceUi,
  storyFromTarget,
  StoryListItem,
  StoryMenuActionId
} from "@once/ui-web"
import { createWebExtPlatform } from "@once/platform-webext"
import { webextAddonConversations } from "./addonConversations"
import { isStoryMenuActionForContext } from "./storyMenuBackground"
import { bindPageActionsPanel } from "./pageActionsPanel"
import {
  TOGGLE_COMMENTS_COMMAND,
  isKeyCommandMessage
} from "./keyCommandBackground"

// Manifest command name → the Once command it runs. The panel is where these
// can be answered at all: the background has no story database.
const RELAYED_COMMANDS: Record<string, string> = {
  [TOGGLE_COMMENTS_COMMAND]: "story.toggle-comments"
}

declare const __ONCE_WEBEXT_TARGET__: "chrome" | "firefox"
declare const __ONCE_BUILD_CHANNEL__: "release" | "dev"
declare const __ONCE_BUILD_IDENTIFIER__: string
declare const __ONCE_BUNDLED_ADDONS__: BundledAddonFiles[]

// The only shortcuts that reach Once while a web page has focus, because only a
// manifest command is delivered when the panel does not have the keyboard:
// opening the panel, and switching the open page between story and comments.
// Read from the browser rather than assumed, so a user who rebound one sees what
// they actually pressed.
//
// Only the browser can change them, and its settings page is not linkable from
// an extension document. Chrome does let an extension *open* chrome:// pages in
// a tab, so there the address becomes a button; Firefox refuses about:addons
// from tabs.create, so there it is copyable text and the last step is spelled
// out.
async function browserManagedShortcuts(): Promise<BrowserManagedShortcut[]> {
  const firefox = __ONCE_WEBEXT_TARGET__ === "firefox"
  const settingsUrl = firefox ? "about:addons" : "chrome://extensions/shortcuts"
  const wanted: [name: string, label: string][] = [
    [
      firefox ? "_execute_sidebar_action" : "open-side-panel",
      "Open the Once panel"
    ],
    [TOGGLE_COMMENTS_COMMAND, "Switch between story and comments"]
  ]
  try {
    const commands = await browser.commands.getAll()
    return wanted.flatMap(([name, label]) => {
      const command = commands.find((entry) => entry.name === name)
      if (!command) return []
      return [{
        label,
        chord: command.shortcut || null,
        settingsUrl,
        hint: firefox
          ? "then the gear menu → Manage Extension Shortcuts"
          : undefined,
        openSettings: firefox
          ? undefined
          : () => void browser.tabs.create({ url: settingsUrl })
      }]
    })
  } catch {
    // Not fatal: the panel works without knowing its own summoning keys.
    return []
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  document.body.dataset.platform = "webext"
  document.body.dataset.webextTarget = __ONCE_WEBEXT_TARGET__
  const storyMenuContextId = crypto.randomUUID()
  const platform = createWebExtPlatform(browser, {
    target: __ONCE_WEBEXT_TARGET__,
    appVersion: browser.runtime.getManifest().version
  })
  const query = new URLSearchParams(window.location.search)
  const testMode = query.has("once-e2e")
  const app = createOnceApp(platform)
  const client = app.client

  await app.start()
  await mountOnceUi(client, {
    shell: "webext",
    readerRuntime: browser.runtime,
    addonSandboxUrl: browser.runtime.getURL("static/addon-sandbox.html"),
    // A test panel starts with no add-ons unless a spec asks for the shipped ones.
    bundledAddons: testMode && !query.has("bundled-addons") ? [] : __ONCE_BUNDLED_ADDONS__,
    addonConversations: webextAddonConversations(browser),
    addonPanel: true,
    browserShortcuts: await browserManagedShortcuts(),
    appVersion: browser.runtime.getManifest().version,
    buildChannel: __ONCE_BUILD_CHANNEL__,
    buildIdentifier: __ONCE_BUILD_IDENTIFIER__,
    showHoveredLinks: __ONCE_WEBEXT_TARGET__ === "chrome",
    tabsPanel: true,
    initialStoryLoad: testMode ? "disabled" : "cache",
    // Register the context-menu action handler without waiting for sources.
    // A freshly opened panel must be able to run What4 while stories load.
    backgroundInitialStoryLoad: true
  })
  bindSentTabNotifications(browser)
  // A manifest command pressed while the page had focus. It arrives as a
  // message because only the background is delivered browser-level keys.
  browser.runtime.onMessage.addListener((message: {
    onceCommand?: string
    command?: string
  }) => {
    if (!isKeyCommandMessage(message)) return
    const id = RELAYED_COMMANDS[message.command]
    if (id) getKeyboardDispatcher().run(id)
  })

  await bindPageActionsPanel(browser, storyMenuContextId)

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

/**
 * Notifications for tabs sent here are optional: the browser asks once,
 * from this button, and the background shows them from then on.
 */
function bindSentTabNotifications(api: typeof browser): void {
  const row = document.querySelector<HTMLElement>("#tab_sync_notifications_row")
  const button = document.querySelector<HTMLButtonElement>("#tab_sync_notifications")
  if (!row || !button) return
  const show = (granted: boolean) => {
    row.hidden = false
    button.disabled = granted
    button.textContent = granted ? "Allowed" : "Allow…"
  }
  void api.permissions.contains({ permissions: ["notifications"] }).then(show)
  // Straight from the click: the browser only asks during a user gesture.
  button.addEventListener("click", () => {
    void api.permissions.request({ permissions: ["notifications"] }).then(show).catch(() => show(false))
  })
}
