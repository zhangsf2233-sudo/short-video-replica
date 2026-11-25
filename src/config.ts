/**
 * 配置：默认值 ← 配置文件 ← 环境变量，后者覆盖前者。
 *
 * 配置文件位置：$VFLOW_CONFIG 或 ~/.vflow/config.json
 * 密钥推荐走环境变量，不要写进仓库。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface EndpointConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface ChatConfig extends EndpointConfig {
  /** 拆解时抽多少帧。 */
  frames: number
  /** 抽帧的最长边像素。 */
  maxSide: number
  timeoutMs: number
}

export interface ImageConfig extends EndpointConfig {
  /** 例如 720x1280。 */
  size: string
  timeoutMs: number
}

export interface VideoConfig extends EndpointConfig {
  /** 单段时长（秒），服务端一般只支持 5 / 10。 */
  secondsPerClip: number
  ratio: string
  resolution: string
  pollMs: number
  timeoutMs: number
}

export interface Config {
  dataDir: string
  ffmpegPath: string
  ffprobePath: string
  ytDlpPath: string
  chat: ChatConfig
  image: ImageConfig
  video: VideoConfig
  /** 成片最长镜头数，超过就分段生成。 */
  maxShotsPerClip: number
  /** 单段最长秒数。 */
  maxSecondsPerClip: number
  subtitle: {
    enabled: boolean
    fontName: string
    fontSize: number
    marginV: number
  }
}

export const CONFIG_PATH_DEFAULT = join(homedir(), '.vflow', 'config.json')

export function configPath(): string {
  const override = (process.env.VFLOW_CONFIG ?? '').trim()
  return override === '' ? CONFIG_PATH_DEFAULT : override
}

export function defaultConfig(): Config {
  return {
    dataDir: join(homedir(), '.vflow', 'runs'),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    ytDlpPath: 'yt-dlp',
    chat: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '',
      model: '',
      frames: 8,
      maxSide: 1024,
      timeoutMs: 180_000,
    },
    image: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '',
      model: '',
      size: '720x1280',
      timeoutMs: 180_000,
    },
    video: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: '',
      model: '',
      secondsPerClip: 5,
      ratio: '9:16',
      resolution: '720p',
      pollMs: 5_000,
      timeoutMs: 900_000,
    },
    maxShotsPerClip: 5,
    maxSecondsPerClip: 15,
    subtitle: {
      enabled: true,
      fontName: 'PingFang SC',
      // 字号是 PlayRes 单位；我们的 PlayRes 就是视频本身，所以这里等于像素
      fontSize: 44,
      marginV: 150,
    },
  }
}

type Json = Record<string, unknown>

function merge<T extends object>(base: T, patch: Json): T {
  const out: Json = { ...(base as Json) }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const current = out[key]
      out[key] = merge(current !== null && typeof current === 'object' ? (current as Json) : {}, value as Json)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** 读配置：文件缺失不报错，权限/格式错误会抛（配置坏了应该立刻知道）。 */
export function loadConfig(): Config {
  const base = defaultConfig()
  const path = configPath()
  const fromFile = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : {}
  const merged = merge(base, fromFile)

  const chat: ChatConfig = {
    ...merged.chat,
    baseUrl: env('VFLOW_CHAT_BASE') ?? merged.chat.baseUrl,
    apiKey: env('VFLOW_CHAT_KEY') ?? merged.chat.apiKey,
    model: env('VFLOW_CHAT_MODEL') ?? merged.chat.model,
  }
  const image: ImageConfig = {
    ...merged.image,
    baseUrl: env('VFLOW_IMAGE_BASE') ?? merged.image.baseUrl,
    apiKey: env('VFLOW_IMAGE_KEY') ?? merged.image.apiKey,
    model: env('VFLOW_IMAGE_MODEL') ?? merged.image.model,
  }
  const video: VideoConfig = {
    ...merged.video,
    baseUrl: env('VFLOW_VIDEO_BASE') ?? merged.video.baseUrl,
    apiKey: env('VFLOW_VIDEO_KEY') ?? merged.video.apiKey,
    model: env('VFLOW_VIDEO_MODEL') ?? merged.video.model,
  }

  return {
    ...merged,
    chat,
    image,
    video,
    dataDir: env('VFLOW_DATA_DIR') ?? merged.dataDir,
    ffmpegPath: env('VFLOW_FFMPEG') ?? merged.ffmpegPath,
    ffprobePath: env('VFLOW_FFPROBE') ?? merged.ffprobePath,
    ytDlpPath: env('VFLOW_YTDLP') ?? merged.ytDlpPath,
  }
}

export function maskSecret(value: string): string {
  if (value === '') return '(未设置)'
  if (value.length <= 8) return `${value.slice(0, 2)}…`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
