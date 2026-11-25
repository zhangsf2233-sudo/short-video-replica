/** 第 2 步：把抽出来的帧交给视觉模型，还原这条片子怎么拍出来的。 */

import type { ChatConfig } from '../config.ts'
import { toDataUrl } from '../files.ts'
import { completeChat, parseJsonLoose, type ContentPart } from '../providers/chat.ts'
import { ANALYZE_SYSTEM, buildAnalyzeUser } from './prompts.ts'
import type { Analysis, AnalyzedShot, ProductBrief } from './types.ts'

interface RawAnalysis {
  title?: unknown
  hook?: unknown
  structure?: unknown
  rhythm?: unknown
  style?: unknown
  viralDna?: unknown
  score?: unknown
  summary?: unknown
  shots?: unknown
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeShot(raw: unknown, index: number, durationSec: number): AnalyzedShot | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const start = Math.max(0, asNumber(record.startSec, 0))
  const end = Math.min(durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY, asNumber(record.endSec, start + 1))
  return {
    index,
    startSec: start,
    endSec: Math.max(start + 0.1, end),
    visual: asText(record.visual, asText(record.description, '产品出镜')),
    action: asText(record.action, '展示产品'),
    narration: asText(record.narration),
    camera: asText(record.camera, '固定机位'),
  }
}

export function normalizeAnalysis(raw: RawAnalysis, durationSec: number): Analysis {
  const rawShots = Array.isArray(raw.shots) ? raw.shots : []
  const shots: AnalyzedShot[] = []
  for (const item of rawShots) {
    const shot = normalizeShot(item, shots.length + 1, durationSec)
    if (shot !== undefined) shots.push(shot)
  }
  if (shots.length === 0) throw new Error('拆解结果里没有镜头，模型输出可能被截断')
  shots.sort((a, b) => a.startSec - b.startSec)
  shots.forEach((shot, index) => { shot.index = index + 1 })

  const structure = Array.isArray(raw.structure)
    ? raw.structure.map(item => asText(item)).filter(item => item !== '')
    : []

  return {
    title: asText(raw.title, '未命名源片'),
    hook: asText(raw.hook, '前 3 秒直接给结论'),
    structure: structure.length > 0 ? structure : ['开场抓人', '卖点展示', '行动号召'],
    rhythm: asText(raw.rhythm, '镜头 2-3 秒一切'),
    style: asText(raw.style, '真实摄影质感，暖色光'),
    viralDna: asText(raw.viralDna, '用低成本场景制造真实感'),
    score: Math.max(0, Math.min(100, Math.round(asNumber(raw.score, 60)))),
    shots,
    summary: asText(raw.summary),
  }
}

export interface AnalyzeOptions {
  frames: string[]
  durationSec: number
  product?: ProductBrief
}

/** 抽帧 → 视觉模型 → 结构化拆解。 */
export async function analyzeSource(config: ChatConfig, options: AnalyzeOptions): Promise<Analysis> {
  if (options.frames.length === 0) throw new Error('没有可分析的帧')

  const parts: ContentPart[] = [{ type: 'text', text: buildAnalyzeUser({ durationSec: options.durationSec, frameLabels: options.frames.map((_, index) => `帧${index + 1}`), product: options.product }) }]
  for (const [index, frame] of options.frames.entries()) {
    parts.push({ type: 'text', text: `帧${index + 1}：` })
    parts.push({ type: 'image_url', image_url: { url: await toDataUrl(frame) } })
  }

  const text = await completeChat(config, {
    system: ANALYZE_SYSTEM,
    user: parts,
    maxTokens: 4_000,
    temperature: 0.2,
    json: true,
  })
  const raw = parseJsonLoose<RawAnalysis>(text)
  return normalizeAnalysis(raw, options.durationSec)
}
