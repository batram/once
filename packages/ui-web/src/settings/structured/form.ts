export function announceStructuredSettings(message: string): void {
  let status = document.getElementById("structured_settings_status")
  if (!status) {
    status = document.createElement("div")
    status.id = "structured_settings_status"
    status.className = "visually_hidden"
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    document.body.append(status)
  }
  status.textContent = message
}

export function createActionButton(
  label: string,
  action: () => void,
  testid?: string
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = label
  if (testid) button.dataset.testid = testid
  button.addEventListener("click", action)
  return button
}

export function createInlineActionButton(
  label: "Save" | "Cancel",
  action: () => void,
  testid?: string
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "structured_inline_action"
  button.title = label
  button.setAttribute("aria-label", label)
  if (testid) button.dataset.testid = testid
  const glyph = document.createElement("span")
  glyph.className = label === "Save" ? "glyph_check" : "glyph_cross"
  glyph.setAttribute("aria-hidden", "true")
  button.append(glyph)
  button.addEventListener("click", action)
  return button
}

export function createRowBody(...children: HTMLElement[]): HTMLElement {
  const body = document.createElement("div")
  body.className = "structured_row_body row"
  body.append(...children)
  return body
}

export function createRowChevron(
  label?: string,
  action?: () => void
): HTMLElement {
  const chevron = action
    ? document.createElement("button")
    : document.createElement("span")
  chevron.className = "structured_row_chevron"
  if (chevron instanceof HTMLButtonElement && action) {
    chevron.type = "button"
    chevron.title = label || "Edit"
    chevron.setAttribute("aria-label", chevron.title)
    chevron.addEventListener("click", action)
  } else {
    chevron.setAttribute("aria-hidden", "true")
  }
  return chevron
}

export function createListCard(title: string, count: number): {
  card: HTMLElement
  rows: HTMLElement
} {
  const card = document.createElement("section")
  card.className = "structured_list_card"
  const header = document.createElement("div")
  header.className = "structured_list_header row"
  const name = document.createElement("strong")
  name.className = "structured_list_name settings_subheading"
  name.textContent = title
  const total = document.createElement("span")
  total.className = "structured_list_count"
  total.textContent = String(count)
  header.append(name, total)
  const rows = document.createElement("div")
  rows.className = "structured_rows"
  card.append(header, rows)
  return { card, rows }
}

export type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
export type StructuredFormField = [
  string,
  string,
  {
    kind?: "text" | "multiline" | "number" | "select" | "checkbox" | "password"
    hint?: string
    choices?: Array<[string, string]>
    optional?: boolean
    multiline?: boolean
    /**
     * Names the run of rows this field belongs to. Consecutive fields sharing
     * a group are rendered under one subheading; fields without one open the
     * form in an unnamed run.
     */
    group?: string
  }?
]

export interface StructuredFormOptions {
  root: HTMLElement
  title: string
  fields: StructuredFormField[]
  /** `true` saved; `false` is the generic complaint, a string names the problem. */
  save(values: string[]): boolean | string
  dismiss(): void
  /**
   * Rows that depend on the fixed fields, rebuilt into `rows` whenever one of
   * those changes: the source form's collector configuration.
   */
  configure?(inputs: FormField[], rows: HTMLElement): void
  onTouch: boolean
  remove?: { label: string; action: () => void }
  host?: HTMLElement
  createTester?(inputs: FormField[]): {
    element: HTMLElement
    corpus: HTMLElement
    refresh(): void
  }
  setDetailTitle?(title: string): void
  setOpenEditor(close: () => void): void
}

function createFormInput(
  options: StructuredFormOptions,
  field: StructuredFormField,
  index: number
): FormField {
  const kind = field[2]?.kind ?? (field[2]?.multiline ? "multiline" : "text")
  let input: FormField
  if (kind === "select") {
    input = document.createElement("select")
    field[2]?.choices?.forEach(([value, label]) => {
      const option = document.createElement("option")
      option.value = value
      option.textContent = label
      input.append(option)
    })
  } else if (kind === "multiline") {
    input = document.createElement("textarea")
    input.rows = options.onTouch && index === 0 ? 3 : 2
  } else {
    input = document.createElement("input")
    input.type = kind === "checkbox" ? "checkbox" : kind
  }
  if (input instanceof HTMLInputElement && input.type === "checkbox") {
    input.className = "switch"
    input.checked = field[1] !== "false"
    input.value = input.checked ? "true" : "false"
    input.addEventListener("change", () => { input.value = input.checked ? "true" : "false" })
  } else input.value = field[1]
  input.required = !field[2]?.optional && kind !== "checkbox"
  return input
}

/**
 * One settings row: the field's name, its hint under the name, and the control
 * beside them. The same three-part row the shell's own settings use, so a form
 * opened inside a section lines up with the section around it.
 */
function appendFormField(
  rows: HTMLElement,
  input: FormField,
  field: StructuredFormField
): void {
  const label = document.createElement("label")
  label.className = "structured_form_field settings_row"
  const name = document.createElement("span")
  name.className = "settings_row_name"
  name.textContent = field[0]
  label.append(name)
  if (field[2]?.hint) {
    const hint = document.createElement("span")
    hint.className = "settings_row_hint"
    hint.textContent = field[2].hint
    label.append(hint)
  }
  label.append(input)
  rows.append(label)
}

/**
 * The switch a form carries in its header rather than among its rows: one
 * question about the whole record — is this thing on — which belongs beside the
 * title it applies to, not in the list of the record's parts.
 */
function appendHeaderToggle(
  header: HTMLElement,
  input: FormField,
  field: StructuredFormField
): void {
  const label = document.createElement("label")
  label.className = "structured_form_toggle"
  const name = document.createElement("span")
  name.className = "field_label"
  name.textContent = field[0]
  label.append(name, input)
  header.append(label)
}

export function showStructuredForm(options: StructuredFormOptions): void {
  if (!options.host) options.root.textContent = ""
  const form = document.createElement("form")
  form.className = "structured_form"
  if (options.createTester) form.classList.add("structured_redirect_form")
  form.dataset.testid = "structured-item-form"
  const header = document.createElement("div")
  header.className = "structured_form_header row"
  const title = document.createElement("h3")
  title.textContent = options.title
  header.append(title)
  form.append(header)
  // Consecutive fields naming the same group share one run of rows. Tracking
  // the last name rather than collecting by name keeps the caller's field
  // order authoritative: a run ends where the caller stopped naming it.
  let rows: HTMLElement | null = null
  let openGroup: string | undefined
  const inputs = options.fields.map((field, index) => {
    const input = createFormInput(options, field, index)
    if (input instanceof HTMLInputElement && input.type === "checkbox") {
      appendHeaderToggle(header, input, field)
      return input
    }
    const group = field[2]?.group
    if (!rows || group !== openGroup) {
      rows = document.createElement("section")
      rows.className = "settings_rows"
      if (group) {
        const heading = document.createElement("h4")
        heading.className = "settings_subheading"
        heading.textContent = group
        rows.append(heading)
      }
      form.append(rows)
      openGroup = group
    }
    appendFormField(rows, input, field)
    return input
  })
  if (options.configure) {
    const configure = options.configure
    const dependent = document.createElement("section")
    dependent.className = "settings_rows structured_form_config"
    dependent.dataset.testid = "structured-config-rows"
    form.append(dependent)
    configure(inputs, dependent)
    form.addEventListener("change", (event) => {
      if (!(event.target instanceof Node) || dependent.contains(event.target)) return
      configure(inputs, dependent)
    })
  }
  const tester = options.createTester?.(inputs)
  if (tester) form.append(tester.element)
  const error = document.createElement("p")
  error.className = "structured_validation"
  error.setAttribute("role", "alert")
  const actions = document.createElement("div")
  actions.className = "structured_form_actions row"
  // A pointer has room for the words and nothing to gain from decoding a
  // glyph; a phone's action bar does not, and its two icons are already the
  // gesture people know there. Same buttons, named where naming is free.
  const commit = (
    label: "Save" | "Cancel",
    action: () => void,
    testid?: string
  ) => {
    if (options.onTouch) return createInlineActionButton(label, action, testid)
    const button = createActionButton(label, action, testid)
    button.className = "button"
    return button
  }
  const save = commit("Save", () => {
    if (!form.reportValidity()) return
    const result = options.save(inputs.map((input) => input.value))
    if (result !== true) {
      error.textContent = typeof result === "string" ? result : "Complete all required fields."
    }
  }, "structured-save")
  const cancel = commit("Cancel", options.dismiss)
  options.setOpenEditor(options.dismiss)
  if (tester) {
    if (options.onTouch) tester.element.append(tester.corpus)
    else actions.append(tester.corpus)
  }
  if (options.remove && options.onTouch) {
    const remove = createActionButton(
      options.remove.label,
      options.remove.action,
      "structured-delete"
    )
    remove.className = "structured_form_delete"
    actions.append(remove)
  }
  actions.append(save, cancel)
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    save.click()
  })
  form.append(error, actions)
  ;(options.host || options.root).append(form)
  if (options.onTouch && !options.host) options.setDetailTitle?.(options.title)
  tester?.refresh()
  inputs[0]?.focus()
}
