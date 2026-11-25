/** 第 6 步：统一规格 → 拼接 → 字幕烧录 → 配轨，输出 final.mp4。 */

import { join } from 'node:path'
import type { Config } from '../config.ts'
import { ensureDir } from '../files.ts'
import { attachAudio, burnSubtitles, concatClips, normalizeClip, probeMedia } from '../media/ffmpeg.ts'
import { buildAss, type SubtitleCue } from '../media/ass.ts'
import { planTimeline } from './script.ts'
import type { ScriptVariant, SourceInfo } from './types.ts'

export interface ComposeOptions {
  config: Config
  variant: ScriptVariant
  clips: Record<string, string>
  source: SourceInfo
  workDir: string
  finalPath: string
  log: (message: string) => void
}

function parseSize(value: string): { width: number, height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim())
  if (match === null) return { width: 720, height: 1280 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

export async function composeFinal(options: ComposeOptions): Promise<string> {
  const { config, variant, clips, source } = options
  const tools = { ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }
  const normalizedDir = await ensureDir(join(options.workDir, 'normalized'))
  const target = parseSize(config.image.size)

  const ordered = variant.segments.map(segment => {
    const path = clips[String(segment.index)]
    if (path === undefined) throw new Error(`段 ${segment.index} 还没有生成视频`)
    return path
  })

  options.log(`统一规格为 ${target.width}x${target.height} / 30fps`)
  const normalized: string[] = []
  for (const [index, clip] of ordered.entries()) {
    const dest = join(normalizedDir, `seg-${String(index + 1).padStart(2, '0')}.mp4`)
    normalizeClip(clip, dest, { width: target.width, height: target.height, fps: 30 }, tools)
    normalized.push(dest)
  }

  const joined = join(options.workDir, 'joined.mp4')
  options.log(`拼接 ${normalized.length} 段`)
  concatClips(normalized, joined, tools)

  const joinedInfo = probeMedia(joined, tools)
  const timeline = planTimeline(variant)
  let subtitled = joined

  if (config.subtitle.enabled) {
    const cues: SubtitleCue[] = timeline
      .filter(item => item.shot.narration.trim() !== '')
      .map(item => ({
        text: item.shot.narration,
        startSec: Math.min(item.startSec, joinedInfo.durationSec),
        endSec: Math.min(item.endSec, joinedInfo.durationSec),
      }))
    if (cues.length > 0) {
      const assPath = join(options.workDir, 'subtitles.ass')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(assPath, buildAss(cues, {
        fontName: config.subtitle.fontName,
        fontSize: config.subtitle.fontSize,
        marginV: config.subtitle.marginV,
        playResX: target.width,
        playResY: target.height,
      }), 'utf8')
      const burned = join(options.workDir, 'subtitled.mp4')
      options.log(`烧录 ${cues.length} 条字幕`)
      burnSubtitles(joined, assPath, burned, tools)
      subtitled = burned
    } else {
      options.log('脚本没有口播文案，跳过字幕')
    }
  }

  options.log(source.hasAudio ? '配源片音轨' : '源片无音轨，铺静音')
  attachAudio(
    subtitled,
    source.hasAudio ? { path: source.path, offsetSec: 0 } : undefined,
    options.finalPath,
    joinedInfo.durationSec,
    tools,
  )
  return options.finalPath
}
