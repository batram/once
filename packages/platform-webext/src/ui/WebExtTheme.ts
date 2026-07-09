export type ThemeName = "system" | "light" | "dark"

export function setDocumentTheme(theme: ThemeName): void {
  document.body.removeAttribute("data-theme")

  if (theme !== "system") {
    document.body.setAttribute("data-theme", theme)
  }

  console.log(`Theme set to: ${theme}`)
}
