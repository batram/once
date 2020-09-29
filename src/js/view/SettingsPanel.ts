import { ipcRenderer } from "electron"
import { OnceSettings } from "../OnceSettings"

export class SettingsPanel {
  constructor() {
    ipcRenderer.send("settings", "subscribe_to_changes")
    ipcRenderer.on(
      "settings",
      async (event, cmd: string, ...args: unknown[]) => {
        switch (cmd) {
          case "set_filter_area":
            console.debug("set_filter_area", args)
            this.set_filter_area()
            break
          case "set_sources_area":
            console.debug("set_sources_area", args)
            this.set_sources_area()
            break
          case "restore_theme_settings":
            console.debug("restore_theme_settings", args)
            this.restore_theme_settings()
            break
          case "restore_animation_settings":
            console.debug("restore_animation_settings", args)
            this.restore_animation_settings()
            break
          default:
            console.log("unhandled settings_panel", cmd)
            event.returnValue = null
        }
      }
    )

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    this.restore_theme_settings()

    const theme_select = document.querySelector<HTMLSelectElement>(
      "#theme_select"
    )
    theme_select.addEventListener("change", () => {
      this.save_theme(theme_select.value)
    })

    const anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    this.restore_animation_settings()
    anim_checkbox.addEventListener("change", () => {
      this.save_animation(anim_checkbox.checked)
    })

    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    this.reset_couch_settings()
    couch_input.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_couch_settings()
      })
    couch_input.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.reset_couch_settings()
      })

    this.set_sources_area()

    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    sources_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_sources_settings()
      })
    sources_area.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.set_sources_area()
      })

    sources_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_sources_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_sources_settings()
      }
    })

    this.set_filter_area()

    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    filter_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_filter_settings()
      })
    filter_area.parentElement
      .querySelector("input[value=cancel]")
      .addEventListener("click", () => {
        this.set_filter_area()
      })

    filter_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_filter_settings()
      }
    })
  }

  async reset_couch_settings(): Promise<void> {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    couch_input.value = await OnceSettings.remote.pouch_get("sync_url", null)
  }

  save_couch_settings(): void {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    ipcRenderer.send("settings", "sync_url", couch_input.value)
  }

  async restore_theme_settings(): Promise<void> {
    const theme_value = await OnceSettings.remote.pouch_get("theme", "dark")

    const theme_select = document.querySelector<HTMLSelectElement>(
      "#theme_select"
    )
    theme_select.value = theme_value
    this.set_theme(theme_value)
  }

  save_theme(name: string): void {
    ipcRenderer.send("settings", "pouch_set", "theme", name)
    this.set_theme(name)
  }

  async restore_animation_settings(): Promise<void> {
    const checked = await OnceSettings.remote.pouch_get("animation", true)

    const anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  save_animation(checked: boolean): void {
    ipcRenderer.send("settings", "pouch_set", "animation", checked)
    const anim_checkbox = document.querySelector<HTMLInputElement>(
      "#anim_checkbox"
    )
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  set_animation(checked: boolean): void {
    document.body.setAttribute("animated", checked.toString())
  }

  set_theme(name: string): void {
    switch (name) {
      case "dark":
        ipcRenderer.send("settings", "set_theme", "dark")
        break
      case "light":
        ipcRenderer.send("settings", "set_theme", "light")
        break
      case "custom":
        console.debug("custom theme, not implement, just hanging out here :D")
        break
      case "system":
        ipcRenderer.send("settings", "set_theme", "system")
        break
    }
  }

  async set_sources_area(): Promise<void> {
    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    const story_sources = await OnceSettings.remote.story_sources()
    sources_area.value = story_sources.join("\n")
  }

  async save_sources_settings(): Promise<void> {
    const sources_area = document.querySelector<HTMLInputElement>(
      "#sources_area"
    )
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    ipcRenderer.send("settings", "pouch_set", "story_sources", story_sources)
  }

  async set_filter_area(): Promise<void> {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filterlist = await OnceSettings.remote.get_filterlist()
    filter_area.value = filterlist.join("\n")
  }

  save_filter_settings(): void {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    ipcRenderer.send("settings", "save_filterlist", filter_list)
  }
}
