/** 流水线的数据契约：每一步的输入输出都是可落盘的纯数据。 */

import type { LogEntry } from '../log.ts'

export type StepId = 'parse' | 'analyze' | 'script' | 'keyframes' | 'clips' | 'compose'

export const STEP_IDS: StepId[] = ['parse', 'analyze', 'script', 'keyframes', 'clips', 'compose']

export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface StepState {
  id: StepId
  status: StepStatus
  message?: string
  startedAt?: string
  endedAt?: string
}

export interface SourceInfo {
  /** file = 本地视频，url = 直链，ytdlp = 从分享链接抓下来的。 */
  kind: 'file' | 'url' | 'ytdlp'
  origin: string
  path: string
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
}

/** 拆解结果里的单个镜头。 */
export interface AnalyzedShot {
  index: number
  startSec: number
  endSec: number
  /** 画面内容。 */
  visual: string
  /** 主体动作。 */
  action: string
  /** 原片口播/字幕文案。 */
  narration: string
  camera: string
}

export interface Analysis {
  title: string
  hook: string
  structure: string[]
  rhythm: string
  style: string
  viralDna: string
  /** 0-100，模型自评的爆款潜力。 */
  score: number
  shots: AnalyzedShot[]
  summary: string
}

export interface ProductBrief {
  name: string
  sellingPoints: string
  audience: string
}

/** 仿写脚本里的单个镜头。 */
export interface ScriptShot {
  index: number
  narration: string
  visual: string
  /** 该镜在成片里的时长（秒）。 */
  durationSec: number
}

/** 一段 = 一次视频模型调用（≤ maxShotsPerClip 且 ≤ maxSecondsPerClip）。 */
export interface Segment {
  index: number
  shots: ScriptShot[]
  /** 拼好的视频模型提示词。 */
  prompt: string
}

export interface ScriptVariant {
  id: 'A' | 'B' | 'C'
  angle: string
  segments: Segment[]
}

export interface RunInput {
  /** 本地文件路径、直链、或分享链接。 */
  source: string
  product?: ProductBrief
  /** 产品图，用于参考首帧。 */
  productImage?: string
  /** 生成哪一版脚本，默认 A。 */
  variant?: 'A' | 'B' | 'C'
  /** 抽帧数量覆盖。 */
  frames?: number
  /** 只跑到脚本这一步就停，用来先审稿再花钱生成视频。 */
  planOnly?: boolean
}

export interface RunState {
  id: string
  createdAt: string
  updatedAt: string
  input: RunInput
  source?: SourceInfo
  analysis?: Analysis
  variants?: ScriptVariant[]
  chosenVariant: 'A' | 'B' | 'C'
  /** 段序号 → 参考首帧文件路径。 */
  keyframes: Record<string, string>
  /** 段序号 → 生成的视频片段路径。 */
  clips: Record<string, string>
  finalVideo?: string
  steps: StepState[]
  /** 复用判据：输入变了就不能用上次的产物。 */
  keys?: { analysis: string, script: string, render: string }
  logs: LogEntry[]
  error?: string
}

export function initialSteps(): StepState[] {
  return STEP_IDS.map(id => ({ id, status: 'pending' as StepStatus }))
}
