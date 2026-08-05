// The catalogue of everything the keyboard can drive.
//
// It is a registry rather than a fixed list: the built-ins below are seeded at
// import time, and anything else — the story actions, and plugins later — calls
// registerKeyCommand(). A command exists here whether or not anything has
// registered a handler for it, so the settings UI can offer it while each shell
// registers only the commands it can actually perform.
//
// What a shell *cannot* perform is a different matter, and is declared up front
// as `shells`. The sidepanel extensions have no tabs to cycle, no address bar to
// focus and no second pane, and the browser swallows Ctrl+T and friends before
// the panel document ever sees them — so those commands are not merely unhandled
// there, they are unofferable. See availableKeyCommands().

export type BuiltinKeyCommandId =
  | "search.focus"
  | "history.undo"
  | "history.redo"
  | "story.cursor-next"
  | "story.cursor-prev"
  | "story.action-left"
  | "story.action-right"
  | "story.open"
  | "story.open-comments"
  | "story.toggle-comments"
  | "browser.new-tab"
  | "browser.close-tab"
  | "browser.restore-closed-tab"
  | "browser.new-window"
  | "browser.focus-urlbar"
  | "browser.next-tab"
  | "browser.prev-tab"
  | "panes.focus-left"
  | "panes.focus-right"
  | "window.toggle-fullscreen"
  | "window.exit-fullscreen"

/**
 * Built-in ids keep their autocomplete; registered ones are ordinary strings.
 */
export type KeyCommandId = BuiltinKeyCommandId | (string & Record<never, never>)

/** See KeyCommandDefinition.allowInTextEntry. */
export type TextEntryReach = "never" | "field" | "always"

export type KeyCommandGroup =
  | "stories"
  | "actions"
  | "browser"
  | "panes"
  | "history"
  | "search"

/**
 * Where a command is allowed to fire.
 * - `global`: anywhere in the shell.
 * - `stories`: only while the story list panel is the active panel.
 * - `browser`: only while focus is inside the Electron content pane.
 */
export type KeyCommandContext = "global" | "stories" | "browser"

/** The shells the UI runs in, as far as command availability is concerned. */
export type ShellId = "electron" | "webext" | "mobile"

export interface KeyCommandDefinition {
  id: KeyCommandId
  /** Shown in settings, and harvested by the settings search index. */
  label: string
  group: KeyCommandGroup
  context: KeyCommandContext
  defaultKeys: string[]
  /**
   * How far the command may reach into text entry.
   * - "never": anything a typist would lose, such as bare letters and arrows.
   * - "field": reaches single-line inputs, but not textareas, sliders or
   *   contenteditable, where the same keys are doing real editing work. This
   *   is what lets the pane jumps leave the search box while the arrow keys
   *   still navigate text in the settings editors.
   * - "always": modified chords no editor claims.
   */
  allowInTextEntry: TextEntryReach
  /**
   * Restricts the command, and its settings row, to the shells that can
   * actually run it. Omitted means every shell.
   */
  shells?: readonly ShellId[]
}

const ELECTRON_ONLY: readonly ShellId[] = Object.freeze(["electron"])

const BUILTIN_KEY_COMMANDS: readonly KeyCommandDefinition[] = Object.freeze([
  {
    id: "search.focus",
    label: "Focus story search",
    group: "search",
    context: "global",
    defaultKeys: ["Ctrl+F"],
    allowInTextEntry: "always"
  },
  {
    id: "history.undo",
    label: "Undo story change",
    group: "history",
    context: "global",
    defaultKeys: ["Ctrl+Z"],
    // Reaches one-line fields: the search box usually holds focus in the story
    // list, and undo that only works when nothing is focused would behave
    // differently from the mouse back button, which has never been guarded.
    // Textareas keep their own text undo.
    allowInTextEntry: "field"
  },
  {
    id: "history.redo",
    label: "Redo story change",
    group: "history",
    context: "global",
    defaultKeys: ["Ctrl+Y"],
    allowInTextEntry: "field"
  },
  {
    id: "story.cursor-prev",
    label: "Previous story",
    group: "stories",
    context: "stories",
    defaultKeys: ["ArrowUp", "W"],
    allowInTextEntry: "never"
  },
  {
    id: "story.cursor-next",
    label: "Next story",
    group: "stories",
    context: "stories",
    defaultKeys: ["ArrowDown", "S"],
    allowInTextEntry: "never"
  },
  {
    id: "story.action-left",
    label: "Run left swipe action",
    group: "stories",
    context: "stories",
    defaultKeys: ["ArrowLeft", "A"],
    allowInTextEntry: "never"
  },
  {
    id: "story.action-right",
    label: "Run right swipe action",
    group: "stories",
    context: "stories",
    defaultKeys: ["ArrowRight", "D"],
    allowInTextEntry: "never"
  },
  {
    id: "story.open",
    label: "Open story",
    group: "stories",
    context: "stories",
    defaultKeys: ["O"],
    allowInTextEntry: "never"
  },
  {
    id: "story.open-comments",
    label: "Open story comments",
    group: "stories",
    context: "stories",
    defaultKeys: ["C"],
    allowInTextEntry: "never"
  },
  {
    id: "story.toggle-comments",
    label: "Switch between story and comments",
    group: "stories",
    // Global, not "stories": it acts on the page that is open, so it has to
    // fire while the content pane holds the keyboard as well.
    context: "global",
    defaultKeys: ["Alt+Shift+C"],
    allowInTextEntry: "always",
    shells: ["electron", "webext"]
  },
  {
    id: "browser.new-tab",
    label: "New tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+T"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.close-tab",
    label: "Close tab",
    group: "browser",
    context: "browser",
    defaultKeys: ["Ctrl+W"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.restore-closed-tab",
    label: "Reopen closed tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Shift+T"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.new-window",
    label: "New window",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+N"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.focus-urlbar",
    label: "Focus address bar",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+L"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.next-tab",
    label: "Next tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Tab"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "browser.prev-tab",
    label: "Previous tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Shift+Tab"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "panes.focus-left",
    label: "Focus story list",
    group: "panes",
    context: "global",
    defaultKeys: ["Alt+Shift+ArrowLeft"],
    allowInTextEntry: "field",
    shells: ELECTRON_ONLY
  },
  {
    id: "panes.focus-right",
    label: "Focus content pane",
    group: "panes",
    context: "global",
    defaultKeys: ["Alt+Shift+ArrowRight"],
    allowInTextEntry: "field",
    shells: ELECTRON_ONLY
  },
  {
    id: "window.toggle-fullscreen",
    label: "Toggle fullscreen",
    group: "panes",
    context: "global",
    defaultKeys: ["F11"],
    allowInTextEntry: "always",
    shells: ELECTRON_ONLY
  },
  {
    id: "window.exit-fullscreen",
    label: "Leave fullscreen",
    group: "panes",
    context: "global",
    defaultKeys: ["Escape"],
    allowInTextEntry: "never",
    shells: ELECTRON_ONLY
  }
] as const)

// Insertion ordered, so the settings UI lists built-ins before anything a
// plugin adds later.
const registry = new Map<string, KeyCommandDefinition>(
  BUILTIN_KEY_COMMANDS.map((command) => [command.id, command])
)

/**
 * Adds a command the user can bind a key to. Returns a function that removes
 * it again, for a plugin being unloaded.
 *
 * Registration has to happen before the keybinding store loads, or a stored
 * override for the command is discarded as unknown; importing the module that
 * registers is enough, since the dispatcher is built lazily on first use.
 */
export function registerKeyCommand(command: KeyCommandDefinition): () => void {
  if (registry.has(command.id)) {
    throw new Error(`Duplicate key command: ${command.id}`)
  }
  registry.set(command.id, command)
  return () => {
    if (registry.get(command.id) === command) registry.delete(command.id)
  }
}

/** Every registered command, in registration order, whatever the shell. */
export function keyCommands(): readonly KeyCommandDefinition[] {
  return [...registry.values()]
}

// Electron is the default so a host that never declares itself keeps the full
// catalogue, which is what every caller got before shells existed.
let shell: ShellId = "electron"

/**
 * Names the shell the UI is mounted in. Must run before the dispatcher is first
 * built: getKeyboardDispatcher() loads the stored bindings on first use, and
 * those are filtered against the shell.
 */
export function setShell(next: ShellId): void {
  shell = next
}

/**
 * The commands this shell can actually run. Everything the user is offered, and
 * everything that may hold a chord, comes from here rather than keyCommands():
 * a command the shell cannot perform must not appear in settings, must not
 * claim a default chord, and must not block another command from taking one.
 */
export function availableKeyCommands(): readonly KeyCommandDefinition[] {
  return keyCommands().filter(
    (command) => !command.shells || command.shells.includes(shell)
  )
}

export function keyCommand(id: string): KeyCommandDefinition | undefined {
  return registry.get(id)
}

export function isKeyCommandId(value: unknown): value is KeyCommandId {
  return typeof value === "string" && registry.has(value)
}
