export function parseFilterRows(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "")
}
