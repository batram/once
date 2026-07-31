const { test, expect } = require("@playwright/test")

const { gotoMobileApp } = require("./helpers/mobile-app")
const { openSettingsSection } = require("./helpers/settings")
const exceptions = require("./button-adoption-exceptions.json")

// The design-system fixture cannot see controls built from settings data. Walk
// every destination exposed by the real Settings index so a newly added
// section enters the primitive contract without maintaining a second list.
async function settingsSections(page) {
  await page.getByTestId("settings-menu").click()
  return page.locator("[data-settings-target]").evaluateAll((rows) =>
    [...new Set(rows.map((row) => row.dataset.settingsTarget).filter(Boolean))]
  )
}

const entries = [...exceptions.boxOwning, ...exceptions.unclassified]
const reviewed = new Set(entries.map(entry => entry.family))

function familiesLackingPrimitive() {
  const counts = {}
  const selector = "button, input[type='button'], input[type='submit']"
  for (const control of document.querySelectorAll(selector)) {
    if (control.classList.contains("button")) continue
    const family = control.classList[0] || "(no class)"
    counts[family] = (counts[family] || 0) + 1
  }
  return counts
}

test("reviewed button-adoption exceptions carry ownership and a deletion condition", () => {
  for (const entry of entries) {
    expect(entry.family).toBeTruthy()
    expect(entry.reason).toBeTruthy()
    expect(entry.phase).toMatch(/^\d+\.\d+$/)
    expect(entry.removeWhen).toBeTruthy()
  }
})

test("every native control adopts .button or is a reviewed exception", async ({ page }) => {
  await gotoMobileApp(page)
  const sections = await settingsSections(page)
  expect(sections.length).toBeGreaterThan(0)

  const seen = new Map()
  const record = (counts) => {
    for (const [family, count] of Object.entries(counts)) {
      seen.set(family, (seen.get(family) || 0) + count)
    }
  }

  record(await page.evaluate(familiesLackingPrimitive))
  for (const section of sections) {
    await openSettingsSection(page, section)
    record(await page.evaluate(familiesLackingPrimitive))
  }

  const unreviewed = [...seen.keys()].filter(family => !reviewed.has(family)).sort()
  expect(
    unreviewed,
    `Native controls outside the .button contract and not reviewed: ${unreviewed.join(", ")}`
  ).toEqual([])

  // A family that no longer appears is debt that was paid; its entry must go.
  // Conditional families need purpose-built state coverage before this guard
  // can decide whether their exception is stale.
  const stale = [...entries]
    .filter(entry => !entry.conditional && !seen.has(entry.family))
    .map(entry => entry.family)
    .sort()
  expect(
    stale,
    `Reviewed families no longer rendered by the covered sections: ${stale.join(", ")}`
  ).toEqual([])
})
