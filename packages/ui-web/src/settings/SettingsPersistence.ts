import { OnceClient, ThemeName } from "@once/app"
import { requireElement } from "../dom"

export class SettingsPersistence {
  constructor(
    private client: OnceClient,
    private settingsChanged: () => void
  ) {}

  async restoreSync(): Promise<void> {
    const input = requireElement<HTMLInputElement>("#couch_input")
    input.value = await this.client.getSyncUrl()
    input.dispatchEvent(new Event("input"))
  }

  saveSync(): void {
    const input = requireElement<HTMLInputElement>("#couch_input")
    const status = requireElement<HTMLElement>("#couch_status")
    status.dataset.state = input.value.trim() ? "connecting" : "disabled"
    status.textContent = input.value.trim()
      ? "Saving and connecting…"
      : "Turning sync off…"
    this.client.setSyncUrl(input.value).then(
      () => {
        input.dispatchEvent(new Event("input"))
        const current = this.client.getSyncStatus()
        status.dataset.state = current.state
        status.textContent = current.message
      },
      (error) => {
        status.dataset.state = "error"
        status.textContent = error instanceof Error
          ? error.message
          : "The sync setting could not be saved"
      }
    )
  }

  async restoreTheme(): Promise<void> {
    const value = await this.client.getTheme()
    requireElement<HTMLSelectElement>("#theme_select").value = value
    this.applyTheme(value)
    this.settingsChanged()
  }

  saveTheme(name: string): void {
    this.client.setTheme(name as ThemeName)
    this.applyTheme(name)
  }

  applyTheme(name: string): void {
    document.body.removeAttribute("data-theme")
    if (name === "dark" || name === "light") {
      document.body.setAttribute("data-theme", name)
    } else if (name === "custom") {
      console.debug("custom theme, not implement, just hanging out here :D")
    }
  }

  async restoreAnimation(): Promise<void> {
    const checked = await this.client.getAnimation()
    requireElement<HTMLInputElement>("#anim_checkbox").checked = checked
    this.applyAnimation(checked)
    this.settingsChanged()
  }

  saveAnimation(checked: boolean): void {
    this.client.setAnimation(checked)
    requireElement<HTMLInputElement>("#anim_checkbox").checked = checked
    this.applyAnimation(checked)
  }

  applyAnimation(checked: boolean): void {
    document.body.setAttribute("animated", checked.toString())
  }

  async restoreCache(): Promise<void> {
    const input = requireElement<HTMLInputElement>("#cache_time_input")
    input.value = (await this.client.getCacheTime()).toString()
    this.settingsChanged()
  }

  async saveCache(): Promise<void> {
    const input = requireElement<HTMLInputElement>("#cache_time_input")
    await this.client.setCacheTime(input.value)
  }
}
