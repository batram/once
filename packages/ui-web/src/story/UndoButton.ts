import { getOnceClient } from "../client"
import { AnchoredMenuItem, openAnchoredMenu } from "../menu/storyAnchoredMenu"
import { ReadState, StoryChange, StoryHistory } from "./StoryHistory"
import { SwipeConfig } from "./swipe/geometry"

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10
/** A menu taller than the screen stops being a choice; older changes stay reachable by tapping. */
const MENU_LIMIT = 20

/**
 * Round undo button that stays in the story list's bottom-right corner.
 *
 * Desktop reaches undo through Ctrl+Z, the mouse back button and the context
 * menu; none of those exist on a phone, and the system back gesture is already
 * a six-level dismissal chain that ends in exitApp — putting a data mutation on
 * it would make "back to leave the app" ambiguous. So undo gets a control of
 * its own, one that is always in the same place and never asks for attention:
 * it only dims when there is nothing to reverse.
 *
 * Under the arrow it names what a tap would take back ("skip", "read"), so it
 * cannot be mistaken for the reload button beside the search field.
 *
 * A tap reverses the most recent change. A long-press lists the changes that
 * can be reversed on their own, so a mis-swipe several rows back can be taken
 * back without unwinding everything done since.
 */
export class UndoButton {
  private static instance?: UndoButton
  private readonly button: HTMLButtonElement
  private readonly label: HTMLSpanElement
  private pressTimer?: ReturnType<typeof setTimeout>
  /** Set once a long-press opened the list, so the release does not also undo. */
  private swallowClick = false
  private enabled = SwipeConfig.current.undoButtonEnabled

  private constructor(private readonly history: StoryHistory) {
    this.button = document.createElement("button")
    this.button.type = "button"
    this.button.classList.add("button", "undo_button")
    this.button.dataset.testid = "undo-button"
    this.button.setAttribute("aria-label", "Undo")
    this.button.title = "Undo (hold for a list)"
    const icon = document.createElement("span")
    icon.classList.add("icon", "icon--undo")
    icon.setAttribute("aria-hidden", "true")
    this.label = document.createElement("span")
    this.label.classList.add("undo_button_label")
    this.label.setAttribute("aria-hidden", "true")
    this.button.append(icon, this.label)

    this.button.addEventListener("click", (event) => {
      if (this.swallowClick) {
        this.swallowClick = false
        event.preventDefault()
        return
      }
      this.history.undo()
    })
    this.installLongPress()
    // Android raises contextmenu for a long-press, and a mouse in a web harness
    // for a right-click; both mean "show me the list".
    this.button.addEventListener("contextmenu", (event) => {
      event.preventDefault()
      if (this.pressTimer === undefined && !this.swallowClick) this.openList()
    })

    const host = document.querySelector("#stories_panel") ?? document.body
    host.append(this.button)

    history.onStateChanged(() => this.refresh())
    const client = getOnceClient()
    const applySettings = () => void client.getSwipeSettings().then((settings) => {
      this.enabled = settings.undoButtonEnabled
      this.refresh()
    })
    client.subscribe("settingsChanged", ({ section }) => {
      if (section === "swipe") applySettings()
    })
    applySettings()
    this.refresh()
  }

  static mount(history = StoryHistory.instance): UndoButton | undefined {
    if (!history) return undefined
    UndoButton.instance ??= new UndoButton(history)
    return UndoButton.instance
  }

  private refresh(): void {
    this.button.hidden = !this.enabled
    // aria-disabled rather than disabled: a disabled button swallows the
    // long-press too, and a dimmed control should still explain itself.
    const empty = !this.history.canUndo
    const latest = this.history.latestChange
    this.label.textContent = latest ? ACTIONS[latest.new_state] : "undo"
    this.button.setAttribute("aria-label", latest ? `Undo ${ACTIONS[latest.new_state]}` : "Undo")
    this.button.classList.toggle("undo_button_empty", empty)
    this.button.setAttribute("aria-disabled", String(empty))
  }

  private installLongPress(): void {
    let startX = 0
    let startY = 0
    const cancel = () => {
      clearTimeout(this.pressTimer)
      this.pressTimer = undefined
      this.button.classList.remove("press_building")
    }
    this.button.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary) return
      cancel()
      this.swallowClick = false
      startX = event.clientX
      startY = event.clientY
      this.button.classList.add("press_building")
      this.pressTimer = setTimeout(() => {
        cancel()
        this.swallowClick = true
        this.openList()
      }, LONG_PRESS_MS)
    })
    this.button.addEventListener("pointermove", (event) => {
      if (
        Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX ||
        Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX
      ) {
        cancel()
      }
    })
    for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
      this.button.addEventListener(type, cancel)
    }
  }

  private openList(): void {
    const changes = this.history.undoableChanges().slice(0, MENU_LIMIT)
    const items: AnchoredMenuItem[] = changes.map((change, index) => ({
      id: `undo-${index}`,
      label: describeChange(change),
      testid: "undo-list-item",
      select: () => this.history.undoChange(change)
    }))
    if (items.length === 0) {
      items.push({
        id: "undo-none",
        label: "Nothing to undo",
        enabled: false,
        testid: "undo-list-empty",
        select: () => undefined
      })
    }
    const menu = document.querySelector<HTMLElement>("#menu")
    openAnchoredMenu({
      anchor: this.button,
      bottomInset: menu ? Math.round(menu.getBoundingClientRect().height) : 0,
      items
    })
  }
}

/** What a tap takes back, short enough to sit under the arrow. */
const ACTIONS: Record<ReadState, string> = {
  skipped: "skip",
  read: "read",
  unread: "unread"
}

const VERBS: Record<ReadState, string> = {
  skipped: "Skipped",
  read: "Marked read",
  unread: "Marked unread"
}

function describeChange(change: StoryChange): string {
  return `${VERBS[change.new_state]} “${change.story.title || change.story.href}”`
}
