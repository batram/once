export interface ModelChoice { id: string; name?: string }
export interface ModelCombo { setModels(models: ModelChoice[]): void }

/**
 * A model field whose list always offers every model. A datalist hides what does not match the
 * typed text, so a field that already holds a model offered only that model; here the matches
 * move to the top and the rest follow under a rule.
 */
export function modelCombo(input: HTMLInputElement): ModelCombo {
  const wrapper = document.createElement("div"); wrapper.className = "ai_combo"
  const list = document.createElement("div"); list.className = "ai_combo_list"; list.setAttribute("role", "listbox"); list.id = `${input.id || "model"}-list`; list.hidden = true
  list.setAttribute("aria-label", "Models")
  const toggle = document.createElement("button"); toggle.type = "button"; toggle.className = "ai_combo_toggle"; toggle.tabIndex = -1; toggle.setAttribute("aria-label", "Show all models")
  input.replaceWith(wrapper); wrapper.append(input, toggle, list)
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", list.id); input.setAttribute("aria-expanded", "false"); input.autocomplete = "off"
  let models: ModelChoice[] = [], options: HTMLElement[] = [], active = -1

  const option = (model: ModelChoice, index: number) => {
    const item = document.createElement("div"); item.className = "ai_combo_option"; item.setAttribute("role", "option"); item.id = `${list.id}-${index}`
    item.setAttribute("aria-selected", String(model.id === input.value))
    const id = document.createElement("span"); id.className = "ai_combo_id"; id.textContent = model.id; item.append(id)
    if (model.name && model.name !== model.id) { const name = document.createElement("span"); name.className = "ai_combo_name"; name.textContent = model.name; item.append(name) }
    item.onclick = () => choose(model)
    return item
  }
  const group = (label: string | null, members: ModelChoice[], offset: number) => {
    const element = document.createElement("div"); element.setAttribute("role", "group"); element.setAttribute("aria-label", label ?? "Models")
    if (label) { const caption = document.createElement("div"); caption.className = "ai_combo_caption"; caption.setAttribute("aria-hidden", "true"); caption.textContent = label; element.append(caption) }
    element.append(...members.map((model, index) => option(model, offset + index)))
    return element
  }
  const render = () => {
    const query = input.value.trim().toLowerCase()
    const matches = query ? models.filter(model => model.id.toLowerCase().includes(query) || model.name?.toLowerCase().includes(query)) : []
    // An exact id leads its matches, so a field opened on a saved model shows that model first.
    matches.sort((a, b) => Number(b.id.toLowerCase() === query) - Number(a.id.toLowerCase() === query))
    const rest = models.filter(model => !matches.includes(model))
    list.replaceChildren(...(matches.length && rest.length ? [group("Matching", matches, 0), group("Other models", rest, matches.length)] : [group(null, [...matches, ...rest], 0)]))
    options = [...list.querySelectorAll<HTMLElement>('[role="option"]')]
    highlight(!list.hidden && matches.length ? 0 : -1)
  }
  const highlight = (index: number) => {
    active = index
    options.forEach((item, position) => item.classList.toggle("ai_combo_active", position === index))
    if (index >= 0) { input.setAttribute("aria-activedescendant", options[index].id); options[index].scrollIntoView({ block: "nearest" }) } else input.removeAttribute("aria-activedescendant")
  }
  const open = () => { if (!models.length) return; list.hidden = false; input.setAttribute("aria-expanded", "true"); render() }
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); highlight(-1) }
  const choose = (model: ModelChoice) => { input.value = model.id; input.dispatchEvent(new Event("input", { bubbles: true })); close(); input.focus() }

  // Keep focus in the field while a pointer picks from the list, so blur does not close it first.
  list.onmousedown = event => event.preventDefault()
  toggle.onmousedown = event => event.preventDefault()
  toggle.onclick = () => { if (list.hidden) { open(); input.focus() } else close() }
  input.onclick = () => { if (list.hidden) open() }
  input.addEventListener("input", () => { if (list.hidden) open(); else render() })
  input.addEventListener("blur", close)
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (list.hidden) { open(); return }
      const down = event.key === "ArrowDown"
      highlight(active < 0 ? (down ? 0 : options.length - 1) : (active + (down ? 1 : -1) + options.length) % options.length)
    } else if (event.key === "Enter" && !list.hidden && active >= 0) {
      event.preventDefault(); options[active].click()
    } else if (event.key === "Escape" && !list.hidden) {
      // Closing the list is this Escape's whole job; it must not also leave the page.
      event.preventDefault(); event.stopPropagation(); close()
    }
  })
  return { setModels: next => { models = next; if (!models.length) close(); render() } }
}
