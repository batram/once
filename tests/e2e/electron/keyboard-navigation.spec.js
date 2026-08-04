const { test, expect } = require("@playwright/test")
const {
  closeApp,
  expectDocumentFocus,
  launchApp,
  openSettingsSection,
  seedLocalSource,
  showAllStories,
  startPageServer
} = require("./electron-harness")
const storyFixture = require("../shared/story-fixture")

// Seeded stories are fetched from the local fixture server through the renderer
// fetch bridge, so those tests must leave it enabled.
const STORY_ENV = { env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" } }

async function seedStories(window, origin) {
  const urls = storyFixture.storyUrls(origin)
  await seedLocalSource(window, storyFixture.sourceLine(origin), urls.alpha)
  await showAllStories(window)
  return urls
}

function cursorHref(window) {
  return window.evaluate(() =>
    document.querySelector("#stories story-item.cursor")?.dataset.href ?? null)
}

test("arrow keys move a cursor through the story list", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedStories(window, server.origin)
    const rows = window.locator("#stories story-item.story")
    await expect(rows.first()).toBeVisible()

    await window.keyboard.press("ArrowDown")
    const first = await cursorHref(window)
    assertHref(first)

    await window.keyboard.press("ArrowDown")
    const second = await cursorHref(window)
    assertHref(second)
    expect(second).not.toBe(first)

    await window.keyboard.press("ArrowUp")
    expect(await cursorHref(window)).toBe(first)

    // WASD is an alias for the arrows, not a separate mode.
    await window.keyboard.press("KeyS")
    expect(await cursorHref(window)).toBe(second)
    await window.keyboard.press("KeyW")
    expect(await cursorHref(window)).toBe(first)

    // The cursor row is the list's tab stop and carries the a11y marker.
    await expect(window.locator("#stories story-item.cursor"))
      .toHaveAttribute("aria-current", "true")
    await expectDocumentFocus(window.locator("#stories story-item.cursor"))
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a swipe action runs on the cursor row and then steps past it", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedStories(window, server.origin)
    await window.keyboard.press("ArrowDown")
    const href = await cursorHref(window)
    assertHref(href)
    await window.keyboard.press("ArrowDown")
    const successor = await cursorHref(window)
    await window.keyboard.press("ArrowUp")
    expect(await cursorHref(window)).toBe(href)

    // The default stage-1 left action is "skip".
    await window.keyboard.press("ArrowLeft")
    await expect(window.locator(`story-item[data-href="${href}"]`).first())
      .toHaveClass(/\bskipped\b/)

    // The story is dealt with, so the cursor moves on instead of riding it
    // down the list as the read-state re-sort moves it.
    await expect.poll(() => cursorHref(window)).toBe(successor)

    // Ctrl+Z is the same undo the mouse gestures use.
    await window.keyboard.press("Control+z")
    await expect(window.locator(`story-item[data-href="${href}"]`).first())
      .not.toHaveClass(/\bskipped\b/)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("browser shortcuts open, cycle, close and reopen tabs", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  const tabs = () => window.evaluate(async () => window.onceElectron.tabs.getAll())
  try {
    const initial = await tabs()
    const blank = initial.find((tab) => tab.active)
    await window.evaluate(
      ([id, url]) => window.onceElectron.tabs.navigate(id, url),
      [blank.id, `${server.origin}/one`]
    )
    await expect.poll(async () => (await tabs())[0].url).toContain("/one")

    await window.keyboard.press("Control+t")
    await expect.poll(async () => (await tabs()).length).toBe(2)

    // Ctrl+Tab wraps around the strip.
    await window.keyboard.press("Control+Tab")
    await expect.poll(async () => (await tabs()).findIndex((tab) => tab.active)).toBe(0)

    const before = (await tabs()).map((tab) => tab.id)
    await window.keyboard.press("Control+Shift+Tab")
    await expect.poll(async () => (await tabs()).findIndex((tab) => tab.active)).toBe(1)

    // Closing the navigated tab and reopening it restores its URL.
    await window.evaluate((id) => window.onceElectron.tabs.close(id), before[0])
    await expect.poll(async () => (await tabs()).length).toBe(1)
    await window.keyboard.press("Control+Shift+T")
    await expect.poll(async () => (await tabs()).length).toBe(2)
    await expect.poll(async () => (await tabs()).map((tab) => tab.url).join(" "))
      .toContain("/one")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("Ctrl+L focuses the address bar and Ctrl+F the story search", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.keyboard.press("Control+l")
    await expectDocumentFocus(window.locator("#urlfield"))

    await window.keyboard.press("Control+f")
    await expectDocumentFocus(window.locator("#searchfield"))
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a remapped shortcut takes effect immediately", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedStories(window, server.origin)
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")

    const slot = window.getByTestId("keybinding-story.cursor-next-0")
    await expect(slot).toHaveText("ArrowDown")
    await slot.click()
    await expect(slot).toHaveAttribute("aria-pressed", "true")
    await window.keyboard.press("KeyJ")
    await expect(slot).toHaveText("J")

    await showAllStories(window)
    // showAllStories leaves the search field focused, where a bare letter is
    // typing rather than a shortcut.
    await window.locator("#searchfield").blur()
    await window.keyboard.press("KeyJ")
    assertHref(await cursorHref(window))

    // The replaced default no longer drives the cursor.
    const afterJ = await cursorHref(window)
    await window.keyboard.press("ArrowDown")
    expect(await cursorHref(window)).toBe(afterJ)

    // The choice survives a restart of the shell renderer.
    await window.reload()
    await expect(window.locator("body")).toHaveAttribute("data-once-ready", "true")
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")
    await expect(window.getByTestId("keybinding-story.cursor-next-0")).toHaveText("J")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a shortcut already in use is refused, and says where it went", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")
    const slot = window.getByTestId("keybinding-story.open-0")
    await slot.click()
    await window.keyboard.press("Control+f")

    const status = window.locator(".keybinding_status")
    await expect(status).toContainText("already used by")
    await expect(status).toHaveClass(/keybinding_status--error/)
    await expect(slot).toHaveText("O")
    // Both ends of the clash are marked, so "already used by" does not send
    // the user hunting down the list for it.
    await expect(window.locator('.keybinding_row[data-command="story.open"]'))
      .toHaveClass(/keybinding_refused/)
    await expect(window.locator('.keybinding_row[data-command="search.focus"]'))
      .toHaveClass(/keybinding_holder/)
    await expect(window.getByTestId("keybinding-search.focus-0")).toHaveText("Ctrl+F")

    // A reserved chord is refused the same way, with advice rather than a bare no.
    await slot.click()
    await window.keyboard.press("Enter")
    await expect(status).toContainText("reserved")
    await expect(status).toContainText("Ctrl, Alt or Shift")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a shortcut can be cleared away entirely", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")
    const slot = window.getByTestId("keybinding-story.cursor-next-0")
    await expect(slot).toHaveText("ArrowDown")

    await window.getByTestId("keybinding-clear-story.cursor-next-0").click()
    // The remaining chord slides down; both have to go for a true unset.
    await expect(slot).toHaveText("S")
    await window.getByTestId("keybinding-clear-story.cursor-next-0").click()
    await expect(slot).toHaveText("Not set")
    await expect(window.locator(".keybinding_status")).toContainText("no shortcut")

    // Unset means unset: the default must not creep back after a reload.
    await window.reload()
    await expect(window.locator("body")).toHaveAttribute("data-once-ready", "true")
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")
    await expect(window.getByTestId("keybinding-story.cursor-next-0"))
      .toHaveText("Not set")

    // The clear cross lives inside the box and keeps its space when there is
    // nothing to clear, so bound and unbound slots stay the same size and the
    // column lines up down the list.
    const boxes = await window.evaluate(() => {
      const slotOf = (testid) => document
        .querySelector(`[data-testid="${testid}"]`)
        .closest(".keybinding_slot")
        .getBoundingClientRect()
      const unset = slotOf("keybinding-story.cursor-next-0")
      const bound = slotOf("keybinding-story.cursor-prev-0")
      return { unset: [unset.width, unset.left], bound: [bound.width, bound.left] }
    })
    expect(boxes.unset).toEqual(boxes.bound)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("shortcut groups are boxed, foldable, and keep their state", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")

    // Story actions is the longest group and nothing is bound in it, so it
    // reads last.
    const groups = await window.evaluate(() =>
      [...document.querySelectorAll("#keyboard_shortcuts .keybinding_group")]
        .map((group) => group.dataset.group))
    expect(groups[0]).toBe("stories")
    expect(groups.at(-1)).toBe("actions")

    const actions = window.locator('.keybinding_group[data-group="actions"]')
    await expect(actions).toHaveAttribute("open", "")
    await actions.locator("summary").click()
    await expect(actions).not.toHaveAttribute("open", "")

    // Editing a binding re-renders the whole list; a folded group must not
    // spring back open underneath the user.
    const slot = window.getByTestId("keybinding-story.open-0")
    await slot.click()
    await window.keyboard.press("Control+Alt+o")
    await expect(slot).toHaveText("Ctrl+Alt+O")
    await expect(window.locator('.keybinding_group[data-group="actions"]'))
      .not.toHaveAttribute("open", "")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("story menu actions are offered as bindable shortcuts", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const urls = await seedStories(window, server.origin)
    await openSettingsSection(window, "keyboard", "#keyboard_shortcuts")

    // Registered actions start unbound; the user picks what they use.
    const slot = window.getByTestId("keybinding-story-action.toggle-bookmark-0")
    await expect(slot).toHaveText("Not set")
    await slot.click()
    await window.keyboard.press("Control+Alt+b")
    await expect(slot).toHaveText("Ctrl+Alt+B")

    await showAllStories(window)
    await window.locator("#searchfield").blur()
    await window.keyboard.press("ArrowDown")
    expect(await cursorHref(window)).toBe(urls.alpha)
    await window.keyboard.press("Control+Alt+b")
    await expect(window.locator(`#stories story-item[data-href="${urls.alpha}"]`))
      .toHaveClass(/\bstared\b/)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("a new tab puts the cursor in the address bar", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp()
  try {
    await window.keyboard.press("Control+t")
    await expect.poll(async () =>
      (await window.evaluate(async () => window.onceElectron.tabs.getAll())).length
    ).toBe(2)
    await expectDocumentFocus(window.locator("#urlfield"))

    // The + button is the same path, so it behaves the same way.
    await window.evaluate(() => document.querySelector("#urlfield").blur())
    await window.locator("#new_tab_btn").click()
    await expect.poll(async () =>
      (await window.evaluate(async () => window.onceElectron.tabs.getAll())).length
    ).toBe(3)
    await expectDocumentFocus(window.locator("#urlfield"))
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("the highlight tracks clicks and shows which pane owns the keyboard", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const urls = await seedStories(window, server.origin)
    const body = window.locator("body")

    // Clicking a row adopts it, so the keys continue from where the eye is.
    await window.locator(`#stories story-item[data-href="${urls.beta}"]`)
      .click({ position: { x: 5, y: 5 } })
    expect(await cursorHref(window)).toBe(urls.beta)
    await expect(body).toHaveAttribute("data-pane-focus", "stories")

    // Moving to the browser pane hands the highlight over to the active tab.
    await window.keyboard.press("Control+ArrowRight")
    await expect(body).toHaveAttribute("data-pane-focus", "browser")
    await expect(window.locator(".electron-tab.active")).toHaveCount(1)

    await window.keyboard.press("Control+ArrowLeft")
    await expect(body).toHaveAttribute("data-pane-focus", "stories")
    expect(await cursorHref(window)).toBe(urls.beta)
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("Enter opens the story under the cursor without being a shortcut", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    await seedStories(window, server.origin)
    await window.keyboard.press("ArrowDown")
    const href = await cursorHref(window)
    assertHref(href)

    await window.keyboard.press("Enter")
    await expect.poll(async () =>
      (await window.evaluate(async () => window.onceElectron.tabs.getAll()))
        .find((tab) => tab.active)?.url
    ).toContain("/story/")

    // Enter stays the property of whatever has focus: the address bar still
    // navigates with it, which a global binding would have swallowed.
    await window.keyboard.press("Control+l")
    await expectDocumentFocus(window.locator("#urlfield"))
    await window.locator("#urlfield").fill(`${server.origin}/one`)
    await window.keyboard.press("Enter")
    await expect.poll(async () =>
      (await window.evaluate(async () => window.onceElectron.tabs.getAll()))
        .find((tab) => tab.active)?.url
    ).toContain("/one")
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

test("opening a story hands the highlight to the tab it opened in", async () => {
  const server = await startPageServer()
  const { electronApp, userData, window } = await launchApp(STORY_ENV)
  try {
    const urls = await seedStories(window, server.origin)
    const body = window.locator("body")
    await window.keyboard.press("ArrowDown")
    await expect(body).toHaveAttribute("data-pane-focus", "stories")

    // The default stage-1 right action opens the story, which moves native
    // focus into the page. The shell sees no DOM event for that, so main
    // reports it — otherwise the story cursor keeps claiming the keyboard.
    await window.keyboard.press("ArrowRight")
    await expect.poll(async () =>
      (await window.evaluate(async () => window.onceElectron.tabs.getAll()))
        .find((tab) => tab.active)?.url
    ).toContain("/story/")
    await expect(body).toHaveAttribute("data-pane-focus", "browser")

    await window.keyboard.press("Control+ArrowLeft")
    await expect(body).toHaveAttribute("data-pane-focus", "stories")
    void urls
  } finally {
    await closeApp(electronApp, userData)
    await server.close()
  }
})

function assertHref(href) {
  expect(href, "expected a story row to hold the keyboard cursor").toBeTruthy()
}
