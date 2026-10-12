import { badge } from "./aiForm"

export interface TokenField { removing(): boolean }

/** A saved token reads as saved, never as an empty field: the field appears only to type a replacement, or when nothing is stored yet. */
export function tokenField(parent: HTMLElement, token: HTMLInputElement, saved: Promise<boolean> | null, failed: (message: string) => void): TokenField {
  const row = document.createElement("div"); row.className = "settings_row ai_token_row"
  const label = document.createElement("label"); label.className = "settings_row_name"; label.textContent = "API token"
  token.id ||= `ai-${crypto.randomUUID()}`; label.htmlFor = token.id
  const control = document.createElement("div"); control.className = "ai_token_control"
  const view = document.createElement("span"); view.className = "ai_token_view"
  const small = (text: string) => { const element = document.createElement("button"); element.type = "button"; element.className = "button"; element.textContent = text; return element }
  const replace = small("Replace"), remove = small("Remove"), undo = small("Undo"), cancel = small("Cancel")
  remove.classList.add("ai_token_remove")
  control.append(view, token, replace, remove, undo, cancel); row.append(label, control); parent.append(row)
  let blank = token.placeholder, has = false, editing = false, removing = false
  const render = () => {
    const mode = removing ? "removing" : has && !editing ? "saved" : "input"
    view.hidden = mode === "input"; token.hidden = mode !== "input"
    replace.hidden = remove.hidden = mode !== "saved"; undo.hidden = mode !== "removing"; cancel.hidden = !(has && editing && !removing)
    if (mode === "saved") { const dots = document.createElement("span"); dots.className = "ai_token_dots"; dots.textContent = "••••••••••••"; view.replaceChildren(badge("Saved", "ok"), dots) }
    if (mode === "removing") view.textContent = "Will be removed when you save"
    row.classList.toggle("ai_token_removing", removing)
    token.placeholder = has ? "Paste a new token" : blank
  }
  replace.onclick = () => { editing = true; render(); token.focus() }
  cancel.onclick = () => { editing = false; token.value = ""; render(); replace.focus() }
  remove.onclick = () => { removing = true; token.value = ""; render(); undo.focus() }
  undo.onclick = () => { removing = false; render(); remove.focus() }
  render()
  void saved?.then(value => { has = value; if (!value) blank = "Paste a token"; render() }, error => failed(error instanceof Error ? error.message : String(error)))
  return { removing: () => removing }
}
