#!/usr/bin/env node
/**
 * svr 命令行入口。
 *
 * 只做三件事：解析参数、组织一次运行、把结果和失败原因说清楚。
 * 真正的编排在 pipeline/run.ts。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configPath, loadConfig, maskSecret } from './config.ts'
import { newRunId } from './files.ts'
import { Logger } from './log.ts'
import { toolAvailable } from './media/ffmpeg.ts'
import { listRuns, runPipeline } from './pipeline/run.ts'
import type { RunInput } from './pipeline/types.ts'

const HELP = `svr — 短视频复刻流水线

用法：
  svr run --source <文件|直链|分享链接> [选项]
  svr doctor          检查 ffmpeg / 配置是否就绪
  svr config          打印当前配置（密钥打码）
  svr runs [--json]   列出历史运行

run 选项：
  --source <s>             必填。本地视频、mp4 直链，或抖音/小红书等分享链接（需 yt-dlp）
  --product-name <name>    产品名，默认「主推产品」
  --selling-points <text>  卖点
  --audience <text>        目标人群
  --product-image <path>   产品图，作为生成参考首帧的参考图
  --variant A|B|C          采用哪一版脚本，默认 A
  --frames <n>             抽帧数量
  --run-id <id>            指定运行目录名
  --resume                 复用该 run 里已完成的步骤
  --plan                   只跑到脚本就停，先审稿再决定要不要生成（省钱）
`


/** 版本号直接读 package.json，避免两处各写一份。 */
function version(): string {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

type Flags = Record<string, string | boolean>

function parseFlags(args: string[]): Flags {
  const flags: Flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === undefined || !token.startsWith('--')) continue
    const key = token.slice(2)
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    } else {
      flags[key] = next
      index += 1
    }
  }
  return flags
}

function text(flags: Flags, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function flag(flags: Flags, key: string): boolean {
  return flags[key] === true || flags[key] === 'true'
}

async function commandDoctor(): Promise<number> {
  const config = loadConfig()
  const rows: Array<[string, string]> = [
    ['配置文件', configPath()],
    ['ffmpeg', `${config.ffmpegPath} ${toolAvailable(config.ffmpegPath) ? '✓' : '✗ 未找到'}`],
    ['ffprobe', `${config.ffprobePath} ${toolAvailable(config.ffprobePath) ? '✓' : '✗ 未找到'}`],
    ['yt-dlp', `${config.ytDlpPath} ${toolAvailable(config.ytDlpPath) ? '✓' : '✗ 未找到（只有分享链接需要）'}`],
    ['对话模型', `${config.chat.model || '(未配置)'} @ ${config.chat.baseUrl} key=${maskSecret(config.chat.apiKey)}`],
    ['图片模型', `${config.image.model || '(未配置)'} @ ${config.image.baseUrl} key=${maskSecret(config.image.apiKey)}`],
    ['视频模型', `${config.video.model || '(未配置)'} @ ${config.video.baseUrl} key=${maskSecret(config.video.apiKey)}`],
    ['运行目录', config.dataDir],
  ]
  const width = Math.max(...rows.map(([key]) => key.length))
  for (const [key, value] of rows) process.stdout.write(`${key.padEnd(width)}  ${value}\n`)

  const ffmpegOk = toolAvailable(config.ffmpegPath)
  if (!ffmpegOk) {
    process.stderr.write('\n✗ ffmpeg 不可用，先安装：brew install ffmpeg\n')
    return 1
  }
  const models = [config.chat.model, config.image.model, config.video.model].filter(item => item === '')
  if (models.length > 0) {
    process.stderr.write('\n! 还有模型没配置：设置环境变量 SVR_CHAT_MODEL / SVR_IMAGE_MODEL / SVR_VIDEO_MODEL，或写进配置文件\n')
  }
  return 0
}

function commandConfig(): number {
  const config = loadConfig()
  const masked = {
    ...config,
    chat: { ...config.chat, apiKey: maskSecret(config.chat.apiKey) },
    image: { ...config.image, apiKey: maskSecret(config.image.apiKey) },
    video: { ...config.video, apiKey: maskSecret(config.video.apiKey) },
  }
  process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`)
  return 0
}

async function commandRuns(flags: Flags): Promise<number> {
  const config = loadConfig()
  const runs = await listRuns(config)
  if (runs.length === 0) {
    process.stdout.write('还没有运行记录\n')
    return 0
  }
  if (flag(flags, 'json')) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`)
    return 0
  }
  for (const run of runs) {
    const state = run.state
    const lastStep = state?.steps.filter(item => item.status === 'done').map(item => item.id).pop() ?? '—'
    const status = state?.error !== undefined ? 'failed' : state?.finalVideo !== undefined ? 'done' : 'partial'
    process.stdout.write(`${run.id}  ${status.padEnd(8)}  ${lastStep.padEnd(10)}  ${state?.input.source ?? ''}\n`)
  }
  return 0
}

async function commandRun(flags: Flags): Promise<number> {
  const source = text(flags, 'source')
  if (source === undefined) {
    process.stderr.write('✗ 缺少 --source（本地文件 / 直链 / 分享链接）\n\n')
    process.stdout.write(HELP)
    return 1
  }

  const explicitRunId = text(flags, 'run-id')
  const resume = flag(flags, 'resume')
  if (resume && explicitRunId === undefined) {
    process.stderr.write('✗ --resume 需要配合 --run-id 使用\n')
    return 1
  }
  // 先定 runId：失败时才能把真实目录报给用户，而不是 <最新>
  const runId = explicitRunId ?? newRunId()

  const variantFlag = text(flags, 'variant')?.toUpperCase()
  const variant = variantFlag === 'A' || variantFlag === 'B' || variantFlag === 'C' ? variantFlag : undefined
  const framesFlag = text(flags, 'frames')
  const frames = framesFlag === undefined ? undefined : Number(framesFlag)

  const productName = text(flags, 'product-name')
  const sellingPoints = text(flags, 'selling-points')
  const audience = text(flags, 'audience')
  const productImage = text(flags, 'product-image')

  const input: RunInput = {
    source,
    ...(productName === undefined && sellingPoints === undefined && audience === undefined
      ? {}
      : { product: { name: productName ?? '主推产品', sellingPoints: sellingPoints ?? '', audience: audience ?? '' } }),
    ...(productImage === undefined ? {} : { productImage }),
    ...(variant === undefined ? {} : { variant }),
    ...(frames === undefined || !Number.isFinite(frames) ? {} : { frames }),
    ...(flag(flags, 'plan') ? { planOnly: true } : {}),
  }

  if (productImage !== undefined && !existsSync(productImage)) {
    process.stderr.write(`✗ 产品图不存在：${productImage}\n`)
    return 1
  }

  const config = loadConfig()
  const logger = new Logger()
  const json = flag(flags, 'json')
  if (!json) {
    process.stderr.write(`源码：${basename(source)}\n`)
    process.stderr.write(`运行目录：${config.dataDir}\n\n`)
  }

  try {
    const state = await runPipeline({
      input,
      config,
      logger,
      runId,
      ...(resume ? { resume: true } : {}),
    })
    if (state.input.planOnly === true) {
      const plan = state.variants ?? []
      const chosenVariant = plan.find(item => item.id === state.chosenVariant) ?? plan[0]
      if (!json) {
        process.stderr.write('\n脚本已就绪（未生成视频，未消耗视频额度）：\n')
        for (const variant of plan) {
          const shots = variant.segments.reduce((sum, segment) => sum + segment.shots.length, 0)
          process.stderr.write(`  ${variant.id} 版（${variant.angle}）：${variant.segments.length} 段 / ${shots} 镜\n`)
        }
        if (chosenVariant !== undefined) {
          process.stderr.write(`\n采用 ${chosenVariant.id} 版的分镜：\n`)
          for (const segment of chosenVariant.segments) {
            for (const shot of segment.shots) {
              process.stderr.write(`  ${String(shot.index).padStart(2, '0')}. ${shot.narration === '' ? '（无口播）' : shot.narration}\n`)
            }
          }
        }
        process.stderr.write(`\n确认后去掉 --plan，用 --resume --run-id ${state.id} 接着生成。\n`)
      }
    }

    const summary = {
      ok: true,
      runId: state.id,
      finalVideo: state.finalVideo,
      variant: state.chosenVariant,
      segments: state.clips === undefined ? 0 : Object.keys(state.clips).length,
      analysis: state.analysis === undefined ? undefined : { title: state.analysis.title, hook: state.analysis.hook, score: state.analysis.score },
      runState: `${config.dataDir}/${state.id}/run.json`,
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`\n✗ 失败：${message}\n`)
    process.stderr.write(`  详细过程见 ${config.dataDir}/${runId}/run.json\n`)
    return 1
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const flags = parseFlags(rest)
  switch (command) {
    case 'run':
      return await commandRun(flags)
    case 'doctor':
      return await commandDoctor()
    case 'config':
      return commandConfig()
    case 'runs':
      return await commandRuns(flags)
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP)
      return command === undefined ? 1 : 0
    case '--version':
    case '-v':
      process.stdout.write(`svr ${version()}\n`)
      return 0
    default:
      process.stderr.write(`✗ 未知命令：${command}\n\n`)
      process.stdout.write(HELP)
      return 1
  }
}

const code = await main(process.argv.slice(2))
process.exitCode = code
