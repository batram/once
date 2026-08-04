import { KEY_COMMANDS, KeyCommandContext, KeyCommandId, keyCommand } from "./commands"

export interface KeybindingConflict {
  chord: string
  commandId: KeyCommandId
  conflictsWith: KeyCommandId
}

/**
 * Two commands can both fire on one chord only when their contexts overlap.
 * "global" reaches everywhere, so it overlaps both panel contexts; "stories"
 * and "browser" are mutually exclusive, so they may share a chord safely.
 */
export function contextsOverlap(a: KeyCommandContext, b: KeyCommandContext): boolean {
  return a === "global" || b === "global" || a === b
}

export function findKeybindingConflicts(
  byCommand: Map<KeyCommandId, string[]>
): KeybindingConflict[] {
  const conflicts: KeybindingConflict[] = []
  const claims = new Map<string, KeyCommandId[]>()
  for (const command of KEY_COMMANDS) {
    for (const chord of byCommand.get(command.id) ?? []) {
      const holders = claims.get(chord)
      if (!holders) {
        claims.set(chord, [command.id])
        continue
      }
      for (const holder of holders) {
        const other = keyCommand(holder)
        if (!other || !contextsOverlap(command.context, other.context)) continue
        conflicts.push({ chord, commandId: command.id, conflictsWith: holder })
      }
      holders.push(command.id)
    }
  }
  return conflicts
}

/**
 * The command a new chord would collide with, or null when it is free. Used by
 * the capture control to refuse a binding instead of silently shadowing one.
 */
export function conflictingCommand(
  byCommand: Map<KeyCommandId, string[]>,
  target: KeyCommandId,
  chord: string
): KeyCommandId | null {
  const command = keyCommand(target)
  if (!command) return null
  for (const other of KEY_COMMANDS) {
    if (other.id === target) continue
    if (!(byCommand.get(other.id) ?? []).includes(chord)) continue
    if (contextsOverlap(command.context, other.context)) return other.id
  }
  return null
}
