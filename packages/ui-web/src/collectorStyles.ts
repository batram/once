import { get_parser } from "@once/collectors"

/**
 * One style rule per collector badge. Rebuilds from the current registry
 * each time, so calling it again after add-on collectors registered adds
 * theirs and drops the ones that left.
 */
export function addCollectorColorStyles(): void {
  for (const stale of document.head.querySelectorAll("style.type_style")) stale.remove()
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
        --collector-bg: ${colors[0]};
        --collector-color: ${colors[1]};
        background-color: var(--collector-bg);
        color: var(--collector-color);
      }
    }`
    document.head.append(style)
  }
}
