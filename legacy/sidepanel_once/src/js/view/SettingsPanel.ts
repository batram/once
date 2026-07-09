import { OnceSettings } from "../OnceSettings"

export class SettingsPanel {
  static instance: SettingsPanel

  constructor() {
    SettingsPanel.instance = this

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    this.restore_theme_settings()

    const theme_select =
      document.querySelector<HTMLSelectElement>("#theme_select")
    theme_select.addEventListener("change", () => {
      this.save_theme(theme_select.value)
    })

    const anim_checkbox =
      document.querySelector<HTMLInputElement>("#anim_checkbox")
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

    const cache_input = document.querySelector<HTMLInputElement>("#cache_input")
    this.reset_cache_settings()
    cache_input.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_cache_settings()
      })
    cache_input.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.reset_cache_settings()
      })

    this.set_sources_area()

    const sources_area =
      document.querySelector<HTMLInputElement>("#sources_area")
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

    this.set_redirect_area()

    const redirect_area =
      document.querySelector<HTMLInputElement>("#redirect_area")
    redirect_area.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_redirect_settings()
      })
    redirect_area.parentElement
      .querySelector("input[value=cancel]")
      .addEventListener("click", () => {
        this.set_redirect_area()
      })

    redirect_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_redirect_settings()
      }
    })
  }

  async reset_couch_settings(): Promise<void> {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    couch_input.value = await OnceSettings.instance.get_sync_url()
  }

  save_couch_settings(): void {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    OnceSettings.instance.set_sync_url(couch_input.value)
  }

  async reset_cache_settings(): Promise<void> {
    const cache_input = document.querySelector<HTMLInputElement>("#cache_input")
    cache_input.value = (
      await OnceSettings.instance.get_cache_time()
    ).toString()
  }

  save_cache_settings(): void {
    const cache_input = document.querySelector<HTMLInputElement>("#cache_input")
    OnceSettings.instance.set_cache_time(cache_input.value)
  }

  async restore_theme_settings(): Promise<void> {
    const theme_value = await OnceSettings.instance.pouch_get("theme", "dark")

    const theme_select =
      document.querySelector<HTMLSelectElement>("#theme_select")
    theme_select.value = theme_value
    this.set_theme(theme_value)
  }

  save_theme(name: string): void {
    OnceSettings.instance.pouch_set("theme", name, console.log)
    this.set_theme(name)
  }

  async restore_animation_settings(): Promise<void> {
    const checked = await OnceSettings.instance.pouch_get("animation", true)

    const anim_checkbox =
      document.querySelector<HTMLInputElement>("#anim_checkbox")
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  save_animation(checked: boolean): void {
    OnceSettings.instance.pouch_set("animation", checked, console.log)
    const anim_checkbox =
      document.querySelector<HTMLInputElement>("#anim_checkbox")
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  set_animation(checked: boolean): void {
    document.body.setAttribute("animated", checked.toString())
  }

  set_theme(name: string): void {
    switch (
      name
      /*
      //TODO: set theme
      case "dark":
        //BackComms.send("settings", "set_theme", "dark")
        break
      case "light":
        BackComms.send("settings", "set_theme", "light")
        break
      case "custom":
        console.debug("custom theme, not implement, just hanging out here :D")
        break
      case "system":
        BackComms.send("settings", "set_theme", "system")
        break*/
    ) {
    }
  }

  async set_sources_area(): Promise<void> {
    const sources_area =
      document.querySelector<HTMLInputElement>("#sources_area")
    const story_sources = await OnceSettings.instance.story_sources()
    sources_area.value = story_sources.join("\n")
  }

  async save_sources_settings(): Promise<void> {
    const sources_area =
      document.querySelector<HTMLInputElement>("#sources_area")
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    OnceSettings.instance.pouch_set("story_sources", story_sources, console.log)
  }

  async set_filter_area(): Promise<void> {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = await OnceSettings.instance.get_filterlist()
    filter_area.value = filter_list.join("\n")
  }

  save_filter_settings(): void {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    OnceSettings.instance.save_filterlist(filter_list)
  }

  async set_redirect_area(): Promise<void> {
    const redirect_area =
      document.querySelector<HTMLInputElement>("#redirect_area")
    const redirect_list = await OnceSettings.instance.get_redirectlist()
    redirect_area.value = OnceSettings.present_redirectlist(redirect_list)
  }

  save_redirect_settings(): void {
    const redirect_area =
      document.querySelector<HTMLInputElement>("#redirect_area")
    const redirect_list = OnceSettings.parse_redirectlist(redirect_area.value)
    OnceSettings.instance.save_redirectlist(redirect_list)
  }
}
