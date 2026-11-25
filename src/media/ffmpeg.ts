/** ffmpeg / ffprobe 封装。所有调用都走参数数组，不拼 shell 字符串。 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'

export interface MediaInfo {
  durationSec: number
  width: number
  height: number
  hasAudio: boolean
}

export class FfmpegError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export interface ToolPaths {
  ffmpegPath: string
  ffprobePath: string
}

/** 跑一条命令；失败时抛错并带上 stderr 尾部（ffmpeg 的报错都在那里）。 */
export function run(bin: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): string {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error !== undefined) throw new Error(`无法执行 ${bin}：${result.error.message}`)
  if (result.status !== 0) {
    const tail = (result.stderr ?? '').trim().split(/\r?\n/).slice(-6).join(' | ')
    throw new FfmpegError(`${bin} 退出码 ${result.status}：${tail}`, result.stderr ?? '')
  }
  return result.stdout ?? ''
}

export function toolAvailable(bin: string): boolean {
  const result = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 10_000 })
  return result.status === 0
}

/** 读媒体信息；无音轨的素材 hasAudio=false。 */
export function probeMedia(path: string, tools: ToolPaths): MediaInfo {
  const stdout = run(tools.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ])
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string, width?: number, height?: number, duration?: string }>
  }
  const streams = parsed.streams ?? []
  const video = streams.find(stream => stream.codec_type === 'video')
  if (video === undefined) throw new Error(`没有视频流：${path}`)
  const duration = Number(parsed.format?.duration ?? video.duration ?? 0)
  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio: streams.some(stream => stream.codec_type === 'audio'),
  }
}

/**
 * 均匀抽帧：按时间点取，比按帧号取稳（不同帧率都能覆盖整段）。
 * 返回图片绝对路径数组。
 */
export function extractFrames(
  videoPath: string,
  outDir: string,
  count: number,
  maxSide: number,
  tools: ToolPaths,
): string[] {
  const info = probeMedia(videoPath, tools)
  if (info.durationSec <= 0) throw new Error(`无法读取时长：${videoPath}`)
  const longSide = Math.max(info.width, info.height)
  const scale = longSide > maxSide ? `scale=${maxSide}:-2` : undefined
  const files: string[] = []
  for (let index = 0; index < count; index += 1) {
    const at = (info.durationSec * (index + 0.5)) / count
    const dest = join(outDir, `frame-${String(index + 1).padStart(2, '0')}.jpg`)
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(3), '-i', videoPath, '-frames:v', '1']
    if (scale !== undefined) args.push('-vf', scale)
    args.push('-q:v', '3', dest)
    run(tools.ffmpegPath, args)
    if (!existsSync(dest)) throw new Error(`抽帧失败：${dest}`)
    files.push(dest)
  }
  return files
}

/** 把任意分辨率的片段统一成同一套编码参数，后面才能无损 concat。 */
export function normalizeClip(
  source: string,
  dest: string,
  target: { width: number, height: number, fps: number },
  tools: ToolPaths,
): void {
  const filter = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${target.fps}`,
  ].join(',')
  run(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an',
    '-movflags', '+faststart',
    dest,
  ])
}

/** concat 分离器拼接（片段参数已统一，可以 -c copy）。 */
export function concatClips(files: string[], dest: string, tools: ToolPaths): void {
  if (files.length === 0) throw new Error('没有可拼接的片段')
  const listPath = join(dirname(dest), 'concat.txt')
  const list = files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
  writeFileSync(listPath, `${list}\n`, 'utf8')
  run(tools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', dest])
}

/**
 * 给视频配一条音轨：有源音频就铺源音频（循环/截断），没有就铺静音。
 * v1 不做 TTS，口播信息已经在字幕里。
 */
export function attachAudio(
  videoPath: string,
  audioSource: { path: string, offsetSec: number } | undefined,
  dest: string,
  durationSec: number,
  tools: ToolPaths,
): void {
  if (audioSource === undefined) {
    run(tools.ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-f', 'lavfi', '-t', durationSec.toFixed(3), '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      dest,
    ])
    return
  }
  run(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    // 源音频通常比成片短：循环铺满，再由 -shortest 截到画面长度
    '-stream_loop', '-1',
    '-ss', audioSource.offsetSec.toFixed(3), '-t', durationSec.toFixed(3), '-i', audioSource.path,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    dest,
  ])
}

/**
 * 烧录 ASS 字幕。
 * 注意：ass 滤镜会把路径当参数解析，这里切到字幕所在目录用相对文件名，绕开转义坑。
 */
export function burnSubtitles(videoPath: string, assPath: string, dest: string, tools: ToolPaths): void {
  const dir = dirname(assPath)
  const name = assPath.slice(dir.length + 1)
  run(tools.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', `ass=filename=${name}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    dest,
  ], { cwd: dir })
}
