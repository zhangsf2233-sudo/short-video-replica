/**
 * 对话 / 视觉模型适配（OpenAI 兼容的 /chat/completions）。
 *
 * 一个坑：推理模型会把 token 先花在 reasoning_content 上，max_tokens 给小了就
 * 出现「content 为空、finish_reason=length」。这里检测到就直接翻倍预算重试一次。
 */

import { requestJson } from '../http.ts'
import type { ChatConfig } from '../config.ts'

export type ContentPart =
  | { type: 'text', text: string }
  | { type: 'image_url', image_url: { url: string } }

export interface ChatRequest {
  system?: string
  user: string | ContentPart[]
  maxTokens?: number
  temperature?: number
  /** 让模型返回 JSON（部分网关支持 response_format）。 */
  json?: boolean
  timeoutMs?: number
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: unknown, reasoning_content?: string }
  }>
  error?: { message?: string, code?: string }
}

const MAX_BUDGET_RETRY = 1

export function extractMessageText(payload: unknown): string {
  const response = payload as ChatResponse
  const choice = response.choices?.[0]
  if (choice === undefined) {
    const message = response.error?.message
    throw new Error(message === undefined ? '模型响应里没有 choices' : `模型报错：${message}`)
  }
  const content = choice.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        const record = part as { text?: unknown }
        return typeof record.text === 'string' ? record.text : ''
      })
      .join('')
  }
  return ''
}

/** 从模型输出里抠 JSON：容忍 ```json 围栏、前后废话、以及末尾被截断的情况。 */
export function parseJsonLoose<T>(text: string): T {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1) throw new Error(`模型没有返回 JSON：${trimmed.slice(0, 200)}`)
  const slice = end > start ? body.slice(start, end + 1) : body.slice(start)
  try {
    return JSON.parse(slice) as T
  } catch (error) {
    throw new Error(`JSON 解析失败（${(error as Error).message}）：${slice.slice(0, 300)}`)
  }
}

export async function completeChat(config: ChatConfig, request: ChatRequest): Promise<string> {
  const messages: Array<{ role: string, content: unknown }> = []
  if (request.system !== undefined && request.system !== '') messages.push({ role: 'system', content: request.system })
  messages.push({ role: 'user', content: request.user })

  let budget = request.maxTokens ?? 2_000
  for (let attempt = 0; attempt <= MAX_BUDGET_RETRY; attempt += 1) {
    const payload = await requestJson<ChatResponse>({
      url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      apiKey: config.apiKey,
      timeoutMs: request.timeoutMs ?? config.timeoutMs,
      body: {
        model: config.model,
        messages,
        max_tokens: budget,
        temperature: request.temperature ?? 0.4,
        ...(request.json === true ? { response_format: { type: 'json_object' } } : {}),
      },
    })
    const text = extractMessageText(payload)
    const truncated = payload.choices?.[0]?.finish_reason === 'length'
    const reasoningOnly = text.trim() === '' && (payload.choices?.[0]?.message?.reasoning_content ?? '') !== ''
    // JSON 场景下被截断的半截 JSON 等于废输出，必须重试；纯文本场景截断还有部分价值，直接返回
    const needsMoreBudget = reasoningOnly || (truncated && (request.json === true || text.trim() === ''))
    if (text.trim() !== '' && !needsMoreBudget) return text
    if (needsMoreBudget && attempt < MAX_BUDGET_RETRY) {
      budget = Math.min(budget * 3, 32_000)
      continue
    }
    // 预算已经加过一轮还是截断：把内容交出去，让调用方在解析时报更明确的错
    if (text.trim() !== '') return text
    throw new Error(`模型返回空内容（finish_reason=${payload.choices?.[0]?.finish_reason ?? 'unknown'}，max_tokens=${budget}）`)
  }
  throw new Error('模型没有返回可用内容')
}
