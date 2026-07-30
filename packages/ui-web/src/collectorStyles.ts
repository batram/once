import { get_parser } from "@once/collectors"

export function addCollectorColorStyles(): void {
  for (const parser of get_parser()) {
    const colors = parser.options.colors
    if (!colors || colors[0] === "") continue

    const bracketedType = `[${parser.options.type}]`
    const style = document.createElement("style")
    style.classList.add("type_style")
    style.textContent = `@layer components {
      .info[data-type='${bracketedType}'] .type {
        background-color: ${colors[0]};
        border-color: ${colors[1]};
        color: ${colors[1]};
      }

      .menu_btn[data-type='${bracketedType}'] {
        background-color: ${colors[0]};
        color: ${colors[1]};
      }
    }`
    document.head.append(style)
  }
}
