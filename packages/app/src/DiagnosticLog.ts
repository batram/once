import { DiagnosticError } from "./types"

export class DiagnosticLog {
  private readonly errors: DiagnosticError[] = []
  private readonly keys = new Set<string>()

  constructor(private readonly publish: (error: DiagnosticError) => void) {}

  snapshot(): DiagnosticError[] {
    return [...this.errors]
  }

  report(error: DiagnosticError): void {
    const key = JSON.stringify(error)
    if (this.keys.has(key)) return
    this.keys.add(key)
    this.errors.push(error)
    this.publish(error)
  }

  reportSettingLoad(setting: string, error: unknown): void {
    this.report({
      severity: "error",
      operation: `settings.load.${setting}`,
      message: `The ${setting} setting could not be loaded; using defaults`,
      details: errorDetails(error)
    })
  }
}

export function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name + ": " + error.message, error.stack]
    .filter(Boolean)
    .join("\n")
}
