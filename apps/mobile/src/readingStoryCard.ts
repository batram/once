// The one remembered choice for the current-story card: the Settings select
// shows it, and collapsing or expanding the card while reading overwrites it,
// so every later story opens the way the last one was left.
const STORY_CARD_STATE_KEY = "once:mobile-story-card-state"

export function storedStoryCardCollapsed(): boolean {
  try {
    return localStorage.getItem(STORY_CARD_STATE_KEY) === "collapsed"
  } catch { return false }
}

export function rememberStoryCardCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORY_CARD_STATE_KEY, collapsed ? "collapsed" : "expanded")
  } catch { /* private mode or quota: the choice lasts the session */ }
}

export function renderStoryTags(tags: Array<{
  class: string
  text: string
  href?: string
  icon?: string
}>): void {
  const container = document.querySelector("#reading_story_tags")
  if (!container) return
  container.replaceChildren()
  for (const tag of tags) {
    const element = document.createElement("span")
    element.classList.add("tag", `tag_${tag.class}`)
    element.textContent = tag.text
    if (tag.icon) {
      element.classList.add("tag--icon")
      element.style.setProperty("--tag-icon", `url(${tag.icon})`)
    }
    container.append(element)
  }
}


/**
 * The current-story card's collapsed state: its toggle button, vertical
 * swipes on the card, and the Settings select. A new story starts from the
 * remembered choice; `resized` lets the native browser follow the card height.
 */
export class StoryCardCollapse {
  private collapsed = false
  private storyHref = ""

  constructor(private readonly resized: () => void) {}

  bind(card: HTMLElement): void {
    required<HTMLButtonElement>("#reading_story_collapse").onclick = () => {
      this.set(!this.collapsed, true)
    }
    // Reveals the mobile-only Layout group before mountOnceUi builds the
    // settings navigation, the same handshake Electron's story position uses.
    required("#mobile_layout_settings").hidden = false
    const select = required<HTMLSelectElement>("#mobile_story_card_state")
    this.renderSetting()
    select.addEventListener("change", () => this.set(select.value === "collapsed", true))
    this.bindSwipe(card)
  }

  showStory(href: string): void {
    if (href === this.storyHref) return
    this.storyHref = href
    this.collapsed = storedStoryCardCollapsed()
  }

  render(): void {
    const card = required("#reading_current_card")
    const button = required<HTMLButtonElement>("#reading_story_collapse")
    card.classList.toggle("reading_story_collapsed", this.collapsed)
    button.textContent = this.collapsed ? "⌄" : "⌃"
    button.setAttribute("aria-expanded", String(!this.collapsed))
    button.setAttribute("aria-label", this.collapsed ? "Expand current story" : "Collapse current story")
  }

  private set(collapsed: boolean, remember = false): void {
    if (remember) {
      rememberStoryCardCollapsed(collapsed)
      this.renderSetting()
    }
    if (this.collapsed === collapsed) return
    this.collapsed = collapsed
    this.render()
    this.resized()
  }

  private renderSetting(): void {
    required<HTMLSelectElement>("#mobile_story_card_state").value =
      storedStoryCardCollapsed() ? "collapsed" : "expanded"
  }

  private bindSwipe(card: HTMLElement): void {
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let vertical = false
    let suppressClick = false

    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const distance = event.clientY - startY
      pointerId = null
      card.classList.remove("reading_story_dragging")
      card.style.removeProperty("--reading-story-drag")
      if (!vertical) return
      suppressClick = Math.abs(distance) > 12
      if (distance <= -32) this.set(true, true)
      if (distance >= 32) this.set(false, true)
    }

    card.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return
      if ((event.target as Element | null)?.closest(
        'a, button, [role="link"], input, select, textarea'
      )) return
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      vertical = false
      card.setPointerCapture(event.pointerId)
    })
    card.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return
      const distanceX = event.clientX - startX
      const distanceY = event.clientY - startY
      if (!vertical && Math.max(Math.abs(distanceX), Math.abs(distanceY)) < 8) {
        return
      }
      if (!vertical && Math.abs(distanceX) >= Math.abs(distanceY)) {
        pointerId = null
        return
      }
      vertical = true
      event.preventDefault()
      const drag = Math.max(-40, Math.min(40, distanceY))
      card.classList.add("reading_story_dragging")
      card.style.setProperty("--reading-story-drag", `${drag}px`)
    })
    card.addEventListener("pointerup", finish)
    card.addEventListener("pointercancel", finish)
    card.addEventListener("click", (event) => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }, true)
  }
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing mobile Reading element: ${selector}`)
  return element
}
