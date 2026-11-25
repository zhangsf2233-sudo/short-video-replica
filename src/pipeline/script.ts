/** 第 3 步：按拆解结果 + 产品信息写 3 版脚本，并切成可生成的段。 */

import type { ChatConfig } from '../config.ts'
import { completeChat, parseJsonLoose } from '../providers/chat.ts'
import { SCRIPT_SYSTEM, buildScriptUser, buildSegmentPrompt } from './prompts.ts'
import type { Analysis, ProductBrief, ScriptShot, ScriptVariant, Segment } from './types.ts'

interface RawShot {
  narration?: unknown
  visual?: unknown
  durationSec?: unknown
}

interface RawSegment {
  shots?: unknown
}

interface RawVariant {
  id?: unknown
  angle?: unknown
  segments?: unknown
}

interface RawScripts {
  variants?: unknown
}

const VARIANT_IDS: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C']

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 把一段镜头按时长缩放到目标总时长，保持相对节奏。 */
function rescale(shots: ScriptShot[], targetSeconds: number): void {
  const total = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  if (total <= 0) {
    const each = targetSeconds / Math.max(1, shots.length)
    shots.forEach(shot => { shot.durationSec = each })
    return
  }
  const factor = targetSeconds / total
  shots.forEach(shot => { shot.durationSec = Math.max(0.5, shot.durationSec * factor) })
  // 缩放后按总和校正最后一镜，避免累计误差。
  const after = shots.reduce((sum, shot) => sum + shot.durationSec, 0)
  const last = shots[shots.length - 1]
  if (last !== undefined) last.durationSec = Math.max(0.5, last.durationSec + (targetSeconds - after))
}

/** 按「最多 N 镜 / 最多 M 秒」切段。 */
export function chunkShots(shots: ScriptShot[], maxShots: number, maxSeconds: number): ScriptShot[][] {
  const chunks: ScriptShot[][] = []
  let current: ScriptShot[] = []
  let seconds = 0
  for (const shot of shots) {
    const wouldExceed = current.length > 0 && (current.length >= maxShots || seconds + shot.durationSec > maxSeconds + 0.001)
    if (wouldExceed) {
      chunks.push(current)
      current = []
      seconds = 0
    }
    current.push(shot)
    seconds += shot.durationSec
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function flattenShots(raw: unknown): ScriptShot[] {
  const segments = Array.isArray(raw) ? raw : []
  const shots: ScriptShot[] = []
  for (const segment of segments) {
    const record = segment as RawSegment
    const rows = Array.isArray(record.shots) ? record.shots : []
    for (const row of rows) {
      const shot = row as RawShot
      const visual = asText(shot.visual)
      if (visual === '') continue
      shots.push({
        index: shots.length + 1,
        narration: asText(shot.narration),
        visual,
        durationSec: Math.max(0.5, asNumber(shot.durationSec, 2)),
      })
    }
  }
  return shots
}

export interface ScriptOptions {
  analysis: Analysis
  product: ProductBrief
  maxShotsPerClip: number
  maxSecondsPerClip: number
  /** 视频模型单段固定时长。 */
  clipSeconds: number
}

/** 生成 3 版脚本，切成段并把提示词拼好。 */
export async function writeVariants(config: ChatConfig, options: ScriptOptions): Promise<ScriptVariant[]> {
  const text = await completeChat(config, {
    system: SCRIPT_SYSTEM,
    user: buildScriptUser({
      analysis: options.analysis,
      product: options.product,
      maxShotsPerClip: options.maxShotsPerClip,
      maxSecondsPerClip: options.maxSecondsPerClip,
    }),
    maxTokens: 6_000,
    temperature: 0.7,
    json: true,
  })

  const raw = parseJsonLoose<RawScripts>(text)
  const rows = Array.isArray(raw.variants) ? raw.variants : []
  if (rows.length === 0) throw new Error('仿写结果里没有 variants')

  const variants: ScriptVariant[] = []
  rows.slice(0, 3).forEach((row, position) => {
    const record = row as RawVariant
    const shots = flattenShots(record.segments)
    if (shots.length === 0) return
    const id = VARIANT_IDS[position] ?? 'A'
    variants.push(buildVariant(id, asText(record.angle, '默认角度'), shots, options))
  })
  if (variants.length === 0) throw new Error('仿写结果的每一版都没有可用镜头')
  return variants
}

function buildVariant(id: 'A' | 'B' | 'C', angle: string, shots: ScriptShot[], options: ScriptOptions): ScriptVariant {
  const chunks = chunkShots(shots, options.maxShotsPerClip, options.maxSecondsPerClip)
  const segments: Segment[] = chunks.map((chunk, position) => {
    rescale(chunk, options.clipSeconds)
    chunk.forEach((shot, index) => { shot.index = position * options.maxShotsPerClip + index + 1 })
    const segment: Segment = { index: position + 1, shots: chunk, prompt: '' }
    segment.prompt = buildSegmentPrompt({
      segment,
      analysis: options.analysis,
      product: options.product,
      seconds: options.clipSeconds,
      hasFirstFrame: true,
    })
    return segment
  })
  return { id, angle, segments }
}
