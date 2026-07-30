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
  body.className = "structured_row_body"
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
  header.className = "structured_list_header"
  const name = document.createElement("strong")
  name.className = "structured_list_name"
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
  { multiline?: boolean; hint?: string }?
]

export interface StructuredFormOptions {
  root: HTMLElement
  title: string
  fields: StructuredFormField[]
  save(values: string[]): boolean
  dismiss(): void
  onTouch: boolean
  remove?: { label: string; action: () => void }
  choices?: Array<[string, string]>
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
  const choices = options.choices && index === options.fields.length - 1
  let input: FormField
  if (choices) {
    input = document.createElement("select")
    options.choices?.forEach(([value, label]) => {
      const option = document.createElement("option")
      option.value = value
      option.textContent = label
      input.append(option)
    })
  } else if (field[2]?.multiline) {
    input = document.createElement("textarea")
    input.rows = options.onTouch && index === 0 ? 3 : 2
  } else {
    input = document.createElement("input")
    input.type = "text"
  }
  input.value = field[1]
  input.required = true
  return input
}

function appendFormField(
  form: HTMLElement,
  input: FormField,
  field: StructuredFormField
): void {
  const label = document.createElement("label")
  label.className = "structured_form_field"
  const name = document.createElement("span")
  name.className = "structured_form_label"
  name.textContent = field[0]
  label.append(name, input)
  if (field[2]?.hint) {
    const hint = document.createElement("span")
    hint.className = "structured_form_hint"
    hint.textContent = field[2].hint
    label.append(hint)
  }
  form.append(label)
}

export function showStructuredForm(options: StructuredFormOptions): void {
  if (!options.host) options.root.textContent = ""
  const form = document.createElement("form")
  form.className = "structured_form"
  if (options.createTester) form.classList.add("structured_redirect_form")
  form.dataset.testid = "structured-item-form"
  const title = document.createElement("h3")
  title.textContent = options.title
  form.append(title)
  const inputs = options.fields.map((field, index) => {
    const input = createFormInput(options, field, index)
    appendFormField(form, input, field)
    return input
  })
  const tester = options.createTester?.(inputs)
  if (tester) form.append(tester.element)
  const error = document.createElement("p")
  error.className = "structured_validation"
  error.setAttribute("role", "alert")
  const actions = document.createElement("div")
  actions.className = "structured_form_actions"
  const save = createInlineActionButton("Save", () => {
    if (!form.reportValidity()) return
    if (!options.save(inputs.map((input) => input.value))) {
      error.textContent = "Complete all required fields."
    }
  }, "structured-save")
  const cancel = createInlineActionButton("Cancel", options.dismiss)
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
