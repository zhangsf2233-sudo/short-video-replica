/**
 * 流水线编排。
 *
 * 状态模型（v2）：
 * - 输入：本次命令参数 > 上次 run.json 里的 input，合并后作为唯一输入源（state.input）。
 *   resume 时省略 --product-name / --product-image 不会丢信息。
 * - 指纹：每一步各自一把 key，只在该步「成功之后」写入 run.json。
 *   输入变化时级联作废下游步骤（状态回 pending、清产物指针），避免旧成片被当成新结果。
 * - 断点：首帧/分镜按段落盘，失败重跑只补缺失的段，不重复支付已完成的调用。
 *
 * 支持的恢复语义：同样的 key + 状态 done + 产物文件还在 = 复用；否则重跑。
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

type KeyName = 'analysis' | 'script' | 'keyframes' | 'clips' | 'compose'

const KEY_OF: Record<StepId, KeyName> = {
  parse: 'analysis',
  analyze: 'analysis',
  script: 'script',
  keyframes: 'keyframes',
  clips: 'clips',
  compose: 'compose',
}

/** 某一步重跑时必须一起作废的下游步骤。 */
const DOWNSTREAM: Record<StepId, StepId[]> = {
  parse: ['analyze', 'script', 'keyframes', 'clips', 'compose'],
  analyze: ['script', 'keyframes', 'clips', 'compose'],
  script: ['keyframes', 'clips', 'compose'],
  keyframes: ['clips', 'compose'],
  clips: ['compose'],
  compose: [],
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

export function defaultProduct(input: RunInput): { name: string, sellingPoints: string, audience: string } {
  const product = input.product
  const name = product?.name?.trim()
  return {
    name: name !== undefined && name !== '' ? name : '主推产品',
    sellingPoints: product?.sellingPoints?.trim() ?? '',
    audience: product?.audience?.trim() ?? '',
  }
}

function pickVariant(variants: ScriptVariant[], id: 'A' | 'B' | 'C'): ScriptVariant {
  const found = variants.find(variant => variant.id === id)
  if (found !== undefined) return found
  throw new Error(`脚本里没有 ${id} 版（模型只产出了 ${variants.map(item => item.id).join('/')}），请换 --variant 或重新生成脚本`)
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

/** 去掉 undefined，避免把上次的值用 undefined 覆盖掉。 */
function compact(input: RunInput): RunInput {
  const out: RunInput = { source: input.source }
  if (input.product !== undefined) out.product = input.product
  if (input.productImage !== undefined) out.productImage = input.productImage
  if (input.variant !== undefined) out.variant = input.variant
  if (input.frames !== undefined) out.frames = input.frames
  return out
}

export async function runPipeline(options: RunOptions): Promise<RunState> {
  const { config, logger } = options
  const runId = options.runId ?? newRunId()
  const paths = runPaths(config.dataDir, runId)
  await ensureDir(paths.root)

  const resume = options.resume === true
  const existing = resume && existsSync(paths.state)
    ? await loadRun(config, runId).catch(() => undefined)
    : undefined
  if (resume && existing === undefined) {
    throw new Error(`找不到可恢复的运行：${paths.state}。去掉 --resume 会新建一次完整运行（会产生费用）。`)
  }

  // 本次参数优先，缺省沿用上次；planOnly 只对本次命令生效，不写进 state
  const { planOnly, ...commandInput } = options.input
  const merged: RunInput = { ...(existing?.input ?? { source: '' }), ...compact(commandInput as RunInput) }
  if (merged.source === '') throw new Error('缺少 --source（或用 --resume 复用上次的源片）')

  const state: RunState = existing ?? {
    id: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    input: merged,
    chosenVariant: merged.variant ?? 'A',
    keyframes: {},
    clips: {},
    steps: initialSteps(),
    logs: [],
  }
  // resume 时 state 与 existing 是同一个对象：先留一份旧指纹作为比较基准
  const previousKeys = existing?.keys === undefined ? undefined : { ...existing.keys }
  state.input = merged
  if (commandInput.variant !== undefined) state.chosenVariant = commandInput.variant

  // 并发段会同时触发落盘：串成一条链，保证快照按顺序写、不会互相覆盖
  let writeChain: Promise<void> = Promise.resolve()
  const persist = (): Promise<void> => {
    const next = writeChain.then(async () => {
      state.updatedAt = new Date().toISOString()
      state.logs = logger.entries.slice(-500)
      await writeJsonAtomic(paths.state, state)
    })
    writeChain = next.catch(() => undefined)
    return next
  }

  const stepOf = (id: StepId) => state.steps.find(item => item.id === id)

  const mark = async (step: StepId, status: StepStatus, message?: string): Promise<void> => {
    const record = stepOf(step)
    if (record === undefined) return
    record.status = status
    if (message !== undefined) record.message = message
    if (status === 'running') record.startedAt = new Date().toISOString()
    if (status === 'done' || status === 'failed') record.endedAt = new Date().toISOString()
    await persist()
  }

  const tools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }
  const product = defaultProduct(state.input)
  const activeVariant = (): ScriptVariant | undefined =>
    state.variants?.find(item => item.id === state.chosenVariant) ?? state.variants?.[0]

  const keysNow = {
    analysis: (): string => hashOf({ source: state.input.source, frames: state.input.frames ?? null, model: config.chat.model }),
    script: (): string => hashOf({
      analysis: state.analysis ?? null,
      product,
      maxShotsPerClip: config.maxShotsPerClip,
      maxSecondsPerClip: config.maxSecondsPerClip,
      clipSeconds: config.video.secondsPerClip,
      model: config.chat.model,
    }),
    keyframes: (): string => hashOf({
      variants: state.variants ?? null,
      variant: state.chosenVariant,
      productImage: state.input.productImage ?? null,
      imageModel: config.image.model,
      size: config.image.size,
      style: state.analysis?.style ?? null,
    }),
    clips: (): string => hashOf({
      variant: state.chosenVariant,
      segmentPrompts: activeVariant()?.segments.map(segment => segment.prompt) ?? [],
      videoModel: config.video.model,
      ratio: config.video.ratio,
      resolution: config.video.resolution,
      clipSeconds: config.video.secondsPerClip,
    }),
    compose: (): string => hashOf({
      clips: Object.entries(state.clips).sort(),
      subtitle: config.subtitle,
      size: config.image.size,
    }),
  }

  /** 产物是否齐（文件得还在）。 */
  const artifactsReady = (id: StepId): boolean => {
    if (id === 'keyframes' || id === 'clips') {
      const variant = activeVariant()
      if (variant === undefined) return false
      const map = id === 'keyframes' ? state.keyframes : state.clips
      return variant.segments.every(segment => {
        const path = map[String(segment.index)]
        return path !== undefined && existsSync(path)
      })
    }
    if (id === 'compose') return state.finalVideo !== undefined && existsSync(state.finalVideo)
    if (id === 'parse') return state.source !== undefined && existsSync(state.source.path)
    return true
  }

  /** 清掉某步的产物指针（输入变了才清，失败重跑时保留已完成的段）。 */
  const clearArtifacts = (id: StepId): void => {
    if (id === 'keyframes') state.keyframes = {}
    if (id === 'clips') state.clips = {}
    if (id === 'compose') state.finalVideo = undefined
    if (id === 'analyze') state.analysis = undefined
    if (id === 'script') state.variants = undefined
    if (id === 'parse') state.source = undefined
  }

  const resetDownstream = async (id: StepId): Promise<void> => {
    for (const child of DOWNSTREAM[id]) {
      const record = stepOf(child)
      if (record !== undefined) {
        record.status = 'pending'
        record.message = undefined
      }
      clearArtifacts(child)
    }
  }

  /**
   * 跑一步：key 变了或产物缺失就重跑，并在成功后才写入新 key。
   * reuse 拿到的是「可以复用的段」；reuseAll 用于整步复用的判断。
   */
  const step = async <T>(
    id: StepId,
    title: string,
    run: (reuse: Record<string, string>) => Promise<T>,
    reuseCached: () => T | undefined,
  ): Promise<T> => {
    const keyName = KEY_OF[id]
    const key = keysNow[keyName]()
    const previous = previousKeys?.[keyName]
    const sameKey = previous === key
    const nothingChanged = sameKey && stepOf(id)?.status === 'done' && artifactsReady(id)

    // 三种「不能复整步」的情况要区分开：
    // - 没有任何指纹（新 run 或旧格式 run.json）→ 当成全新跑
    // - 有指纹但本步没有（上一步就失败了）→ 续跑，保留已完成的段
    // - 有指纹且不同 → 输入变了，清产物并级联作废下游
    const keyChanged = previousKeys === undefined ? true : previous !== undefined && previous !== key
    const continuation = previousKeys !== undefined && previous === undefined

    if (nothingChanged) {
      const cached = reuseCached()
      if (cached !== undefined) {
        logger.step(id, `${title}：复用上次结果`)
        return cached
      }
    }

    if (keyChanged) {
      clearArtifacts(id)
      await resetDownstream(id)
    }

    logger.step(id, title)
    await mark(id, 'running')
    try {
      // 续跑时把已完成的段交回生成器复用，只有输入变了才从零开始
      const keepSegments = continuation || sameKey
      const reuse = keepSegments ? (id === 'keyframes' ? state.keyframes : id === 'clips' ? state.clips : {}) : {}
      const value = await run({ ...reuse })
      state.keys = { ...(state.keys ?? {}), [keyName]: key }
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

  try {
    const source = await step(
      'parse',
      `解析源片：${state.input.source}`,
      async () => await resolveSource({
        input: state.input.source,
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
        const count = Math.max(2, Math.min(24, state.input.frames ?? config.chat.frames))
        logger.step('analyze', `抽 ${count} 帧`)
        const frames = extractFrames(source.path, framesDir, count, config.chat.maxSide, tools)
        return await analyzeSource(config.chat, { frames, durationSec: source.durationSec, product })
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
        product,
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

    if (planOnly === true) {
      await writeJsonAtomic(join(paths.root, 'script.json'), { analysis, variants, chosen: variant.id })
      await persist()
      logger.step('script', `--plan：脚本已写入 ${join(paths.root, 'script.json')}，跳过生成`)
      return state
    }

    const keyframes = await step(
      'keyframes',
      `生成 ${variant.segments.length} 张参考首帧`,
      async reuse => {
        const result = await generateKeyframes({
          config,
          variant,
          product,
          style: analysis.style,
          ...(state.input.productImage === undefined ? {} : { productImage: state.input.productImage }),
          imagesDir: paths.images,
          log: message => logger.step('keyframes', message),
          reuse,
          onSegment: async (key, path) => {
            state.keyframes[key] = path
            await persist()
          },
        })
        state.keyframes = result
        return result
      },
      () => state.keyframes,
    )
    state.keyframes = keyframes

    const clips = await step(
      'clips',
      `生成 ${variant.segments.length} 段分镜视频`,
      async reuse => {
        const result = await generateClips({
          config,
          variant,
          keyframes,
          clipsDir: paths.clips,
          log: message => logger.step('clips', message),
          reuse,
          onSegment: async (key, path) => {
            state.clips[key] = path
            await persist()
          },
        })
        state.clips = result
        return result
      },
      () => state.clips,
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
      () => state.finalVideo,
    )
    state.finalVideo = finalVideo
    state.error = undefined
    await persist()
    logger.step('compose', `完成 → ${finalVideo}`)
    return state
  } catch (error) {
    await persist()
    throw error
  }
}
