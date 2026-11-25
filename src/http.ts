/** HTTP 小工具：超时、重试、下载、JSON 解析。 */

export class HttpError extends Error {
  constructor(readonly status: number, readonly body: string, url: string) {
    super(`HTTP ${status} ${url}：${body.slice(0, 300)}`)
    this.name = 'HttpError'
  }
}

export interface JsonRequest {
  url: string
  method?: 'GET' | 'POST'
  apiKey?: string
  body?: unknown
  timeoutMs?: number
  retries?: number
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 带重试的 JSON 请求：网络错误与 429/5xx 退避重试，其余直接抛。 */
export async function requestJson<T>(options: JsonRequest): Promise<T> {
  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(1_000 * 2 ** (attempt - 1), 8_000))
    try {
      const response = await fetch(options.url, {
        method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined || options.apiKey === '' ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      })
      const text = await response.text()
      if (!response.ok) {
        if (RETRYABLE.has(response.status) && attempt < retries) {
          lastError = new HttpError(response.status, text, options.url)
          continue
        }
        throw new HttpError(response.status, text, options.url)
      }
      if (text.trim() === '') return {} as T
      try {
        return JSON.parse(text) as T
      } catch {
        throw new Error(`响应不是 JSON（${options.url}）：${text.slice(0, 200)}`)
      }
    } catch (error) {
      if (error instanceof HttpError && !RETRYABLE.has(error.status)) throw error
      lastError = error
      if (attempt >= retries) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 下载到本地文件；失败重试两次。 */
export async function download(url: string, dest: string, timeoutMs = 300_000): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1_000 * attempt)
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}：${url}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength === 0) throw new Error(`下载内容为空：${url}`)
      await writeFile(dest, buffer)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
