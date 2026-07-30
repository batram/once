import {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings,
  OnceClient
} from "@once/app"
import {
  SwipeSettingsPersistence,
  SwipeSettingsPersistenceState
} from "./SwipeSettingsPersistence"
import { SwipeSettingsLabView } from "./SwipeSettingsLabView"

/** Public composition facade for the interactive swipe-settings editor. */
export class SwipeSettingsLab {
  private readonly persistence: SwipeSettingsPersistence
  private readonly view: SwipeSettingsLabView

  constructor(
    host: HTMLElement,
    client: OnceClient,
    onUiChanged: () => void
  ) {
    const initial = normalizeSwipeSettings(DEFAULT_SWIPE_SETTINGS)
    this.view = new SwipeSettingsLabView(host, initial, {
      replace: (settings) => this.persistence.replace(settings),
      update: (patch) => this.persistence.update(patch),
      undo: () => this.persistence.undo()
    })
    this.persistence = new SwipeSettingsPersistence(initial, client, {
      onStateChanged: (state) => this.render(state),
      onLocalChange: onUiChanged
    })
    void this.persistence.restore()
  }

  externalSettingsChanged(): void {
    this.persistence.externalSettingsChanged()
  }

  private render(state: SwipeSettingsPersistenceState): void {
    this.view.update(state)
  }
}
