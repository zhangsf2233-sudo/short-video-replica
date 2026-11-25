/** 极简结构化日志：每一步一行，便于在终端和 run.json 里对齐。 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  at: string
  step: string
  level: LogLevel
  message: string
}

export class Logger {
  readonly entries: LogEntry[] = []
  private readonly sink?: (entry: LogEntry) => void

  constructor(sink?: (entry: LogEntry) => void) {
    this.sink = sink
  }

  step(step: string, message: string): void {
    this.write(step, 'info', message)
  }

  warn(step: string, message: string): void {
    this.write(step, 'warn', message)
  }

  error(step: string, message: string): void {
    this.write(step, 'error', message)
  }

  private write(step: string, level: LogLevel, message: string): void {
    const entry: LogEntry = { at: new Date().toISOString(), step, level, message }
    this.entries.push(entry)
    const mark = level === 'error' ? '✗' : level === 'warn' ? '!' : '·'
    process.stderr.write(`[${step}] ${mark} ${message}\n`)
    this.sink?.(entry)
  }
}
