import { normalizeSwipeSettings, SwipeSettings } from "@once/app"

const SAVE_DEBOUNCE_MS = 700

interface SwipeSettingsStore {
  getSwipeSettings(): Promise<SwipeSettings>
  setSwipeSettings(settings: SwipeSettings): Promise<void>
}

interface QueuedSave {
  snapshot: SwipeSettings
  undo: SwipeSettings | null
}

export interface SwipeSettingsPersistenceState {
  settings: SwipeSettings
  status: "saved" | "saving" | "failed"
  canUndo: boolean
}

export interface SwipeSettingsPersistenceOptions {
  debounceMs?: number
  schedule?: (callback: () => void, delay: number) => unknown
  cancel?: (timer: unknown) => void
  onStateChanged?: (state: SwipeSettingsPersistenceState) => void
  onLocalChange?: () => void
}

function copy(settings: SwipeSettings): SwipeSettings {
  return normalizeSwipeSettings(settings)
}

function same(a: SwipeSettings, b: SwipeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Owns debounced, serialized swipe-settings writes and external reconciliation.
 */
export class SwipeSettingsPersistence {
  private current: SwipeSettings
  private pendingUndo: SwipeSettings | null = null
  private undoTarget: SwipeSettings | null = null
  private saveTimer?: unknown
  private queued?: QueuedSave
  private saving = false
  private failed = false
  private externalChangePending = false
  private ownSaveEvent = false
  private readonly debounceMs: number
  private readonly schedule: (callback: () => void, delay: number) => unknown
  private readonly cancel: (timer: unknown) => void

  constructor(
    initialSettings: SwipeSettings,
    private readonly store: SwipeSettingsStore,
    private readonly options: SwipeSettingsPersistenceOptions = {}
  ) {
    this.current = copy(initialSettings)
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS
    this.schedule = options.schedule ??
      ((callback, delay) => setTimeout(callback, delay))
    this.cancel = options.cancel ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  get state(): SwipeSettingsPersistenceState {
    return {
      settings: copy(this.current),
      status: this.failed
        ? "failed"
        : this.hasLocalWork() ? "saving" : "saved",
      canUndo: Boolean(this.undoTarget) && !this.hasLocalWork()
    }
  }

  update(patch: Partial<SwipeSettings>): void {
    this.replace({ ...this.current, ...patch })
  }

  replace(
    settings: SwipeSettings,
    options: { undoable?: boolean } = {}
  ): void {
    const next = copy(settings)
    if (same(next, this.current)) return
    if (options.undoable !== false && !this.pendingUndo) {
      this.pendingUndo = copy(this.current)
    }
    this.current = next
    this.failed = false
    this.undoTarget = null
    if (this.saveTimer) this.cancel(this.saveTimer)
    this.saveTimer = this.schedule(() => this.queueCurrent(), this.debounceMs)
    this.emit()
    this.options.onLocalChange?.()
  }

  undo(): void {
    if (!this.undoTarget || this.hasLocalWork()) return
    const target = copy(this.undoTarget)
    this.undoTarget = null
    this.replace(target, { undoable: false })
  }

  async restore(): Promise<void> {
    const settings = copy(await this.store.getSwipeSettings())
    if (this.hasLocalWork()) {
      this.externalChangePending = true
      return
    }
    this.current = settings
    this.pendingUndo = null
    this.undoTarget = null
    this.failed = false
    this.emit()
  }

  externalSettingsChanged(): void {
    if (this.ownSaveEvent) return
    if (this.hasLocalWork()) {
      this.externalChangePending = true
      return
    }
    void this.restore()
  }

  private queueCurrent(): void {
    this.saveTimer = undefined
    this.queued = {
      snapshot: copy(this.current),
      undo: this.pendingUndo ? copy(this.pendingUndo) : null
    }
    this.pendingUndo = null
    void this.drainSaves()
  }

  private async drainSaves(): Promise<void> {
    if (this.saving || !this.queued) return
    const request = this.queued
    this.queued = undefined
    this.saving = true
    this.ownSaveEvent = true
    this.emit()
    try {
      await this.store.setSwipeSettings(request.snapshot)
      this.undoTarget = request.undo ? copy(request.undo) : null
      this.failed = false
    } catch (error) {
      console.error("Failed to save swipe settings", error)
      this.failed = true
      this.queued = request
    } finally {
      this.ownSaveEvent = false
      this.saving = false
    }

    if (!this.failed && this.queued) {
      void this.drainSaves()
      return
    }
    if (this.externalChangePending && !this.hasLocalWork()) {
      this.externalChangePending = false
      await this.restore()
      return
    }
    this.emit()
  }

  private hasLocalWork(): boolean {
    return Boolean(this.saveTimer || this.saving || this.queued)
  }

  private emit(): void {
    this.options.onStateChanged?.(this.state)
  }
}
