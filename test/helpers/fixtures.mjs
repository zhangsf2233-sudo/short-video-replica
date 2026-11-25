// 测试素材：全部用 ffmpeg 现场生成，不往仓库里塞二进制。
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const FFMPEG = process.env.VFLOW_FFMPEG ?? 'ffmpeg'

export function ffmpegAvailable() {
  const result = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' })
  return result.status === 0
}

function run(args) {
  const result = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 120_000 })
  if (result.status !== 0) throw new Error(`ffmpeg 失败：${(result.stderr ?? '').slice(-500)}`)
}

/** 造三条素材：待分析的源片、模拟视频模型产出的片段、参考图。 */
export function makeFixtures(dir) {
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 'source.mp4')
  const clip = join(dir, 'clip.mp4')
  const image = join(dir, 'frame.png')

  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-shortest', '-pix_fmt', 'yuv420p', source,
  ])

  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=30:duration=5',
    '-pix_fmt', 'yuv420p', clip,
  ])

  run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=orange:size=360x640:duration=1',
    '-frames:v', '1', image,
  ])

  return { source, clip, image }
}
