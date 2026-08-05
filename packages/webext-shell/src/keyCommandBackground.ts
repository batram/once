/**
 * Browser-level shortcuts relayed to the panel.
 *
 * A key pressed while a web page has focus never reaches the panel document —
 * only a manifest `commands` entry is delivered at all, and only to the
 * background. But the background has no story database to consult, so it does
 * not act on the command: it hands it to the panel, which owns the app.
 *
 * Nothing happens when the panel is closed. That is the honest behaviour rather
 * than a gap: with no panel there is no selected story, so there is nothing to
 * switch between.
 */

export const TOGGLE_COMMENTS_COMMAND = "toggle-comments"

export interface KeyCommandMessage {
  onceCommand: "key-command"
  command: string
}

export function isKeyCommandMessage(
  message: { onceCommand?: string; command?: string }
): message is KeyCommandMessage {
  return message.onceCommand === "key-command" && typeof message.command === "string"
}

export function installKeyCommandBackground(browserApi: typeof browser): void {
  browserApi.commands.onCommand.addListener((command) => {
    if (command !== TOGGLE_COMMENTS_COMMAND) return
    const message: KeyCommandMessage = { onceCommand: "key-command", command }
    // Rejects with "Could not establish connection" when no panel is listening,
    // which is the ordinary closed-panel case rather than an error to report.
    void browserApi.runtime.sendMessage(message).catch(() => undefined)
  })
}
