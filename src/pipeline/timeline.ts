/**
 * 字幕时间轴：按「片段的真实时长」摊镜头，而不是按脚本里的估算时长。
 *
 * 为什么需要这层：视频模型实际返回的片段长度常常不等于请求的时长（截断、补齐、
 * 变帧率都会导致偏差）。如果字幕仍用脚本估算值，第 2 段开始就会整体漂移。
 * 这里以 ffprobe 量到的真实时长为准，段内镜头按脚本比例分配。
 */

import type { SubtitleCue } from '../media/ass.ts'
import type { ScriptVariant, Segment, ScriptShot } from './types.ts'

export interface TimedShot {
  shot: ScriptShot
  startSec: number
  endSec: number
}

function scriptedSeconds(segment: Segment): number {
  return segment.shots.reduce((sum, shot) => sum + shot.durationSec, 0)
}

/** 把一段的所有镜头摊到 [offsetSec, offsetSec + 实际时长] 上。 */
export function spreadSegment(segment: Segment, actualSeconds: number, offsetSec = 0): TimedShot[] {
  const scripted = scriptedSeconds(segment)
  const span = actualSeconds > 0 ? actualSeconds : scripted
  if (span <= 0 || segment.shots.length === 0) return []

  const timed: TimedShot[] = []
  let cursor = offsetSec
  for (const shot of segment.shots) {
    const share = scripted > 0 ? (shot.durationSec / scripted) * span : span / segment.shots.length
    timed.push({ shot, startSec: cursor, endSec: cursor + share })
    cursor += share
  }
  return timed
}

/** 整条成片的字幕事件：actualDurations[i] 是第 i 段视频的真实时长（秒）。 */
export function buildCues(variant: ScriptVariant, actualDurations: number[]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  let offset = 0
  variant.segments.forEach((segment, index) => {
    const actual = actualDurations[index] ?? 0
    const timed = spreadSegment(segment, actual, offset)
    for (const item of timed) {
      const text = item.shot.narration.trim()
      if (text === '') continue
      cues.push({ text, startSec: item.startSec, endSec: item.endSec })
    }
    offset += actual > 0 ? actual : scriptedSeconds(segment)
  })
  return cues
}

/** 纯展示用：按脚本估算时长排一遍，不用于烧字幕。 */
export function planTimeline(variant: ScriptVariant): TimedShot[] {
  const timed: TimedShot[] = []
  let offset = 0
  for (const segment of variant.segments) {
    for (const item of spreadSegment(segment, scriptedSeconds(segment), offset)) {
      timed.push(item)
      offset = item.endSec
    }
  }
  return timed
}
