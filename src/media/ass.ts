/** ASS 字幕生成：一行一个字幕事件，居中底部，带描边。 */

export interface SubtitleCue {
  text: string
  startSec: number
  endSec: number
}

export interface AssStyle {
  fontName: string
  fontSize: number
  marginV: number
  /** 720 宽基准的字幕分辨率，播放器会自己缩放。 */
  playResX: number
  playResY: number
}

/** 秒 → ASS 时间戳 H:MM:SS.cc（厘秒，两位）。 */
export function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds)
  const totalCentis = Math.round(clamped * 100)
  const cs = totalCentis % 100
  const totalSeconds = (totalCentis - cs) / 100
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** 换行：中文字幕每行最多 maxChars 字，超过就折行（ASS 用 \N）。 */
export function wrapText(text: string, maxChars = 14): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean === '') return ''
  const chars = [...clean]
  if (chars.length <= maxChars) return clean
  const lines: string[] = []
  for (let index = 0; index < chars.length; index += maxChars) {
    lines.push(chars.slice(index, index + maxChars).join(''))
  }
  return lines.join('\\N')
}

export function buildAss(cues: SubtitleCue[], style: AssStyle): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${style.fontName},${style.fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,60,60,${style.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const events = cues
    .filter(cue => cue.text.trim() !== '' && cue.endSec > cue.startSec)
    .map(cue => `Dialogue: 0,${formatAssTime(cue.startSec)},${formatAssTime(cue.endSec)},Default,,0,0,0,,${wrapText(cue.text)}`)
  return `${[...header, ...events].join('\n')}\n`
}
