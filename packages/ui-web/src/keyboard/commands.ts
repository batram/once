// The catalogue of everything the keyboard can drive. A command exists here
// whether or not anything has registered a handler for it: the settings UI
// lists the full catalogue, and shells register only the commands they can
// actually perform.

export type KeyCommandId =
  | "search.focus"
  | "history.undo"
  | "history.redo"
  | "story.cursor-next"
  | "story.cursor-prev"
  | "story.action-left"
  | "story.action-right"
  | "story.open"
  | "story.open-comments"
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

/** See KeyCommandDefinition.allowInTextEntry. */
export type TextEntryReach = "never" | "field" | "always"

export type KeyCommandGroup = "stories" | "browser" | "panes" | "history" | "search"

/**
 * Where a command is allowed to fire.
 * - `global`: anywhere in the shell.
 * - `stories`: only while the story list panel is the active panel.
 * - `browser`: only while focus is inside the Electron content pane.
 */
export type KeyCommandContext = "global" | "stories" | "browser"

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
   *   is what lets Ctrl+Arrow leave the search box while still jumping words
   *   in the settings editors.
   * - "always": modified chords no editor claims.
   */
  allowInTextEntry: TextEntryReach
  /** Restricts the command, and its settings row, to one shell. */
  platform?: "electron"
}

export const KEY_COMMANDS: readonly KeyCommandDefinition[] = Object.freeze([
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
    id: "browser.new-tab",
    label: "New tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+T"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.close-tab",
    label: "Close tab",
    group: "browser",
    context: "browser",
    defaultKeys: ["Ctrl+W"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.restore-closed-tab",
    label: "Reopen closed tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Shift+T"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.new-window",
    label: "New window",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+N"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.focus-urlbar",
    label: "Focus address bar",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+L"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.next-tab",
    label: "Next tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Tab"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "browser.prev-tab",
    label: "Previous tab",
    group: "browser",
    context: "global",
    defaultKeys: ["Ctrl+Shift+Tab"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "panes.focus-left",
    label: "Focus story list",
    group: "panes",
    context: "global",
    defaultKeys: ["Ctrl+ArrowLeft"],
    allowInTextEntry: "field",
    platform: "electron"
  },
  {
    id: "panes.focus-right",
    label: "Focus content pane",
    group: "panes",
    context: "global",
    defaultKeys: ["Ctrl+ArrowRight"],
    allowInTextEntry: "field",
    platform: "electron"
  },
  {
    id: "window.toggle-fullscreen",
    label: "Toggle fullscreen",
    group: "panes",
    context: "global",
    defaultKeys: ["F11"],
    allowInTextEntry: "always",
    platform: "electron"
  },
  {
    id: "window.exit-fullscreen",
    label: "Leave fullscreen",
    group: "panes",
    context: "global",
    defaultKeys: ["Escape"],
    allowInTextEntry: "never",
    platform: "electron"
  }
] as const)

const BY_ID = new Map<string, KeyCommandDefinition>(
  KEY_COMMANDS.map((command) => [command.id, command])
)

export function keyCommand(id: string): KeyCommandDefinition | undefined {
  return BY_ID.get(id)
}

export function isKeyCommandId(value: unknown): value is KeyCommandId {
  return typeof value === "string" && BY_ID.has(value)
}
