/**
 * 流水线编排：每一步的产物都落盘，失败时 run.json 里能看到卡在哪一步。
 * 支持 --resume：已完成且产物还在的步骤直接复用，不重复烧钱。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.ts'
import { ensureDir, newRunId, runPaths, writeJsonAtomic } from '../files.ts'
import type { Logger } from '../log.ts'
import { extractFrames } from '../media/ffmpeg.ts'
import { analyzeSource } from './analyze.ts'
import { composeFinal } from './compose.ts'
import { generateClips, generateKeyframes } from './generate.ts'
import { writeVariants } from './script.ts'
import { resolveSource } from './source.ts'
import {
  initialSteps,
  type RunInput,
  type RunState,
  type ScriptVariant,
  type StepId,
  type StepStatus,
} from './types.ts'

export interface RunOptions {
  input: RunInput
  config: Config
  logger: Logger
  /** 指定就复用这个 run 目录（配合 resume）。 */
  runId?: string
  resume?: boolean
}


/** 指纹：只把影响产物的输入算进去，配置里与产物无关的字段不参与。 */
function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

const KEY_OF = {
  parse: 'analysis',
  analyze: 'analysis',
  script: 'script',
  keyframes: 'render',
  clips: 'render',
  compose: 'render',
} as const

export function defaultProduct(input: RunInput): { name: string, sellingPoints: string, audience: string } {
  const product = input.product
  return {
    name: product?.name?.trim() !== undefined && product?.name?.trim() !== '' ? product.name.trim() : '主推产品',
    sellingPoints: product?.sellingPoints?.trim() ?? '',
    audience: product?.audience?.trim() ?? '',
  }
}

function pickVariant(variants: ScriptVariant[], id: 'A' | 'B' | 'C'): ScriptVariant {
  return variants.find(variant => variant.id === id) ?? variants[0] as ScriptVariant
}

export async function loadRun(config: Config, runId: string): Promise<RunState> {
  const paths = runPaths(config.dataDir, runId)
  const text = await readFile(paths.state, 'utf8')
  return JSON.parse(text) as RunState
}

export async function listRuns(config: Config): Promise<Array<{ id: string, state?: RunState }>> {
  if (!existsSync(config.dataDir)) return []
  const entries = await readdir(config.dataDir, { withFileTypes: true })
  const runs: Array<{ id: string, state?: RunState }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      runs.push({ id: entry.name, state: await loadRun(config, entry.name) })
    } catch {
      runs.push({ id: entry.name })
    }
  }
  return runs.sort((a, b) => b.id.localeCompare(a.id))
}

export async function runPipeline(options: RunOptions): Promise<RunState> {
  const { config, logger } = options
  const runId = options.runId ?? newRunId()
  const paths = runPaths(config.dataDir, runId)
  await ensureDir(paths.root)

  const existing = options.resume === true && existsSync(paths.state)
    ? await loadRun(config, runId).catch(() => undefined)
    : undefined

  const state: RunState = existing ?? {
    id: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: options.input,
    chosenVariant: options.input.variant ?? 'A',
    keyframes: {},
    clips: {},
    steps: initialSteps(),
    logs: [],
  }
  // 注意：resume 时 state 与 existing 是同一个对象，先留一份旧指纹，
  // 否则后面 state.keys = keys 会把比较基准一起改掉，导致永远判成「没变」。
  const previousKeys = existing?.keys === undefined ? undefined : { ...existing.keys }
  state.input = { ...state.input, ...options.input }
  // resume 时 --variant 可能变了：脚本是三个版本一起生成的，这里只要切换选用
  if (options.input.variant !== undefined) state.chosenVariant = options.input.variant

  const persist = async (): Promise<void> => {
    state.updatedAt = new Date().toISOString()
    state.logs = logger.entries.slice(-500)
    await writeJsonAtomic(paths.state, state)
  }

  const mark = async (step: StepId, status: StepStatus, message?: string): Promise<void> => {
    const record = state.steps.find(item => item.id === step)
    if (record === undefined) return
    record.status = status
    if (message !== undefined) record.message = message
    if (status === 'running') record.startedAt = new Date().toISOString()
    if (status === 'done' || status === 'failed') record.endedAt = new Date().toISOString()
    await persist()
  }

  const product = defaultProduct(state.input)
  const keys = {
    analysis: hashOf({ source: state.input.source, frames: state.input.frames ?? null }),
    script: hashOf({
      source: state.input.source,
      frames: state.input.frames ?? null,
      product,
      maxShotsPerClip: config.maxShotsPerClip,
      maxSecondsPerClip: config.maxSecondsPerClip,
      clipSeconds: config.video.secondsPerClip,
    }),
    render: hashOf({
      source: state.input.source,
      frames: state.input.frames ?? null,
      product,
      maxShotsPerClip: config.maxShotsPerClip,
      maxSecondsPerClip: config.maxSecondsPerClip,
      clipSeconds: config.video.secondsPerClip,
      variant: state.chosenVariant,
      productImage: state.input.productImage ?? null,
      ratio: config.video.ratio,
      size: config.image.size,
      subtitle: config.subtitle,
    }),
  }
  if (previousKeys !== undefined) {
    const stale = (Object.keys(keys) as Array<keyof typeof keys>).filter(name => previousKeys[name] !== keys[name])
    if (stale.length > 0) logger.warn('run', `输入有变化（${stale.join('/')}），相关步骤会重新执行`)
  }
  state.keys = keys

  const done = (step: StepId): boolean => {
    if (existing === undefined) return false
    if (state.steps.find(item => item.id === step)?.status !== 'done') return false
    return previousKeys?.[KEY_OF[step]] === keys[KEY_OF[step]]
  }

  const step = async <T>(id: StepId, title: string, run: () => Promise<T>, reuse?: () => T | undefined): Promise<T> => {
    if (done(id)) {
      const cached = reuse?.()
      if (cached !== undefined) {
        logger.step(id, `${title}：复用上次结果`)
        return cached
      }
    }
    logger.step(id, title)
    await mark(id, 'running')
    try {
      const value = await run()
      await mark(id, 'done')
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await mark(id, 'failed', message)
      state.error = message
      await persist()
      throw error
    }
  }

  const tools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }

  try {
    const source = await step(
      'parse',
      `解析源片：${options.input.source}`,
      async () => await resolveSource({
        input: options.input.source,
        workDir: paths.root,
        tools,
        ytDlpPath: config.ytDlpPath,
        log: message => logger.step('parse', message),
      }),
      () => state.source,
    )
    state.source = source

    const analysis = await step(
      'analyze',
      `拆解 ${source.durationSec.toFixed(1)}s 的源片`,
      async () => {
        const framesDir = await ensureDir(paths.frames)
        const count = Math.max(2, Math.min(24, options.input.frames ?? config.chat.frames))
        logger.step('analyze', `抽 ${count} 帧`)
        const frames = extractFrames(source.path, framesDir, count, config.chat.maxSide, tools)
        return await analyzeSource(config.chat, {
          frames,
          durationSec: source.durationSec,
          product: defaultProduct(options.input),
        })
      },
      () => state.analysis,
    )
    state.analysis = analysis
    logger.step('analyze', `钩子：${analysis.hook}｜评分 ${analysis.score}`)

    const variants = await step(
      'script',
      '仿写 3 版脚本',
      async () => await writeVariants(config.chat, {
        analysis,
        product: defaultProduct(options.input),
        maxShotsPerClip: config.maxShotsPerClip,
        maxSecondsPerClip: config.maxSecondsPerClip,
        clipSeconds: config.video.secondsPerClip,
      }),
      () => state.variants,
    )
    state.variants = variants

    const variant = pickVariant(variants, state.chosenVariant)
    state.chosenVariant = variant.id
    logger.step('script', `采用 ${variant.id} 版（${variant.angle}），共 ${variant.segments.length} 段`)

    if (options.input.planOnly === true) {
      await writeJsonAtomic(join(paths.root, 'script.json'), { analysis, variants, chosen: variant.id })
      await persist()
      logger.step('script', `--plan：脚本已写入 ${join(paths.root, 'script.json')}，跳过生成`)
      return state
    }

    const keyframes = await step(
      'keyframes',
      `生成 ${variant.segments.length} 张参考首帧`,
      async () => await generateKeyframes({
        config,
        variant,
        product: defaultProduct(options.input),
        style: analysis.style,
        ...(options.input.productImage === undefined ? {} : { productImage: options.input.productImage }),
        imagesDir: paths.images,
        log: message => logger.step('keyframes', message),
      }),
      () => (Object.keys(state.keyframes).length > 0 ? state.keyframes : undefined),
    )
    state.keyframes = keyframes

    const clips = await step(
      'clips',
      `生成 ${variant.segments.length} 段分镜视频`,
      async () => await generateClips({
        config,
        variant,
        keyframes,
        clipsDir: paths.clips,
        log: message => logger.step('clips', message),
      }),
      () => (Object.keys(state.clips).length > 0 ? state.clips : undefined),
    )
    state.clips = clips

    const finalVideo = await step(
      'compose',
      '合成成片',
      async () => await composeFinal({
        config,
        variant,
        clips,
        source,
        workDir: paths.root,
        finalPath: paths.final,
        log: message => logger.step('compose', message),
      }),
      () => (existsSync(paths.final) ? paths.final : undefined),
    )
    state.finalVideo = finalVideo
    await persist()
    logger.step('compose', `完成 → ${finalVideo}`)
    return state
  } catch (error) {
    await persist()
    throw error
  }
}
