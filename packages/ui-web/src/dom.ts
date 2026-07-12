export function requireElement<T extends Element>(
  selector: string,
  root: ParentNode = document
): T {
  const element = root.querySelector<T>(selector)
  if (element) return element
  throw new Error(`Required UI element not found: ${selector}`)
}

export function requireClosestElement<T extends Element>(
  element: Element,
  selector: string
): T {
  const closest = element.closest<T>(selector)
  if (closest) return closest
  throw new Error(`Required UI ancestor not found: ${selector}`)
}
