/** 第 1 步：把「本地文件 / 直链 / 分享链接」统一成一条可分析的本地视频。 */

import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { download } from '../http.ts'
import { ensureDir } from '../files.ts'
import { probeMedia, run, type ToolPaths, type MediaInfo } from '../media/ffmpeg.ts'
import type { SourceInfo } from './types.ts'

const DIRECT_VIDEO = /\.(mp4|mov|m4v|webm|mkv)(\?|$)/i

export interface SourceOptions {
  input: string
  workDir: string
  tools: ToolPaths
  ytDlpPath: string
  log: (message: string) => void
}

function infoToSource(kind: SourceInfo['kind'], origin: string, path: string, info: MediaInfo): SourceInfo {
  return {
    kind,
    origin,
    path,
    durationSec: info.durationSec,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
  }
}

/** 用 yt-dlp 抓分享链接；抓不到就把失败原因带上（含缺失提示）。 */
async function fetchWithYtDlp(options: SourceOptions): Promise<SourceInfo> {
  const target = join(options.workDir, 'source.mp4')
  const toolCheck = (() => {
    try {
      run(options.ytDlpPath, ['--version'], { timeoutMs: 15_000 })
      return true
    } catch {
      return false
    }
  })()
  if (!toolCheck) {
    throw new Error(`这个链接需要 yt-dlp 才能下载，但没找到 ${options.ytDlpPath}。安装：brew install yt-dlp（或 pipx install yt-dlp），或直接传本地视频。`)
  }
  options.log('用 yt-dlp 下载…')
  run(options.ytDlpPath, [
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '-o', target,
    options.input,
  ], { timeoutMs: 600_000 })
  if (!existsSync(target)) throw new Error('yt-dlp 没有产出视频文件')
  return infoToSource('ytdlp', options.input, target, probeMedia(target, options.tools))
}

export async function resolveSource(options: SourceOptions): Promise<SourceInfo> {
  await ensureDir(options.workDir)
  const input = options.input.trim()
  if (input === '') throw new Error('--source 不能为空')

  if (/^https?:\/\//i.test(input)) {
    if (DIRECT_VIDEO.test(input)) {
      const target = join(options.workDir, `source${extname(new URL(input).pathname) || '.mp4'}`)
      options.log(`下载直链 → ${basename(target)}`)
      await download(input, target)
      return infoToSource('url', input, target, probeMedia(target, options.tools))
    }
    return await fetchWithYtDlp(options)
  }

  if (!existsSync(input)) throw new Error(`找不到文件：${input}`)
  options.log(`使用本地视频 ${basename(input)}`)
  return infoToSource('file', input, input, probeMedia(input, options.tools))
}
