/** 三段提示词：拆解、仿写、首帧。集中放在这里，方便调。 */

import type { Analysis, ProductBrief, ScriptShot, Segment } from './types.ts'

export const ANALYZE_SYSTEM = `你是短视频结构分析师。用户给你一条短视频的若干等间隔截图（按时间顺序）和它的时长。
你的任务是还原这条片子是怎么被做出来的：钩子在哪、信息怎么推进、节奏怎么卡、靠什么让人看完。

只输出 JSON，不要解释，不要 Markdown 围栏。字段：
{
  "title": "一句话概括这条片子在卖什么/讲什么",
  "hook": "前 3 秒具体在做什么来抓人",
  "structure": ["按时间顺序的结构段，3-6 条，每条一句话"],
  "rhythm": "剪辑/镜头节奏描述，比如镜头平均时长、切点密度",
  "style": "画面风格：景别、光线、色调、场景",
  "viralDna": "这条片子可复用的爆款机制（一句话）",
  "score": 0-100 的整数，爆款潜力自评,
  "summary": "两条以内的整体判断",
  "shots": [
    {
      "index": 从 1 开始的镜号,
      "startSec": 该镜开始秒数,
      "endSec": 该镜结束秒数,
      "visual": "画面里有什么：主体、场景、道具、文字",
      "action": "主体在这一镜做了什么",
      "narration": "这一镜的口播或字幕原文；没有就空字符串",
      "camera": "景别与运镜"
    }
  ]
}
规则：shots 覆盖整条片子且时间连续；镜号从 1 递增；不确定的字段给空字符串，不要编造品牌名。`

export function buildAnalyzeUser(input: {
  durationSec: number
  frameLabels: string[]
  product?: ProductBrief
}): string {
  const lines = [
    `源片时长：${input.durationSec.toFixed(1)} 秒。`,
    `共 ${input.frameLabels.length} 张截图，按时间顺序排列：${input.frameLabels.join('、')}。`,
  ]
  if (input.product !== undefined) {
    lines.push(`这条片子要复刻给的产品是「${input.product.name}」，拆解时注意它原本靠什么卖点留人。`)
  }
  lines.push('请按系统提示的 JSON 结构输出。')
  return lines.join('\n')
}

export const SCRIPT_SYSTEM = `你是短视频编导。输入是一条已拆解的爆款片子和一个要推广的产品，你要产出 3 版可执行的复刻脚本。

只输出 JSON，不要解释，不要 Markdown 围栏。结构：
{
  "variants": [
    {
      "id": "A",
      "angle": "这一版的切入角度，一句话",
      "segments": [
        {
          "shots": [
            {
              "narration": "这一镜的口播/字幕文案，口语化，一句不超过 20 个字，没有口播就给空字符串",
              "visual": "这一镜的画面描述，要具体到景别、主体、动作、场景，供视频模型理解",
              "durationSec": 该镜秒数，整数，1-5
            }
          ]
        }
      ]
    }
  ]
}
规则：
1. variants 固定 3 个，id 分别为 A、B、C，角度要真的不同（A 忠实原结构，B 换反差/悬念，C 换场景或人群）。
2. 每版总时长控制在 10-15 秒，镜头数 3-5 个，按 segments 分组，每组就是一个连续生成单元。
3. 保留原片的钩子机制，但文案必须换成产品的，不要照抄原片句子。
4. 画面描述里不要出现品牌 Logo、不要出现文字水印。
5. 产品外观由参考图决定，文字里只描述产品如何被使用/展示。`

export function buildScriptUser(input: {
  analysis: Analysis
  product: ProductBrief
  maxShotsPerClip: number
  maxSecondsPerClip: number
}): string {
  const { analysis, product } = input
  return [
    '【原片拆解】',
    `标题：${analysis.title}`,
    `钩子：${analysis.hook}`,
    `结构：${analysis.structure.join(' / ')}`,
    `节奏：${analysis.rhythm}`,
    `风格：${analysis.style}`,
    `爆款机制：${analysis.viralDna}`,
    `原片镜头：${analysis.shots.map(shot => `${shot.index}. ${shot.visual}（${shot.action}）`).join('；')}`,
    '',
    '【要推广的产品】',
    `名称：${product.name}`,
    `卖点：${product.sellingPoints === '' ? '（未提供，按画面自行合理表达）' : product.sellingPoints}`,
    `目标人群：${product.audience === '' ? '（未提供）' : product.audience}`,
    '',
    `【生成约束】每个 segment 最多 ${input.maxShotsPerClip} 个镜头、总时长不超过 ${input.maxSecondsPerClip} 秒（视频模型单次调用上限）。`,
    '请输出 3 版脚本的 JSON。',
  ].join('\n')
}

/** 视频模型的提示词：把一段的所有镜头压进一条自然语言，强调连续性与可执行动作。 */
export function buildSegmentPrompt(input: {
  segment: Segment
  analysis: Analysis
  product: ProductBrief
  seconds: number
  hasFirstFrame: boolean
}): string {
  const { segment, analysis, product, seconds } = input
  const shots = segment.shots
    .map(shot => `镜头${shot.index}（约${shot.durationSec}秒）：${shot.visual}。${shot.narration === '' ? '' : `口播：${shot.narration}`}`)
    .join('\n')
  const lines = [
    input.hasFirstFrame
      ? '参考图是本段的起始帧：构图、主体位置、光线以它为准。'
      : '本段没有起始帧参考，请自行建立一致的场景。',
    `总时长约 ${seconds} 秒，包含 ${shots.length} 个镜头，按顺序硬切，不加转场特效。`,
    '',
    '[画面一致性]',
    `产品：${product.name}，外观、材质、颜色与参考图完全一致，不改变形状与配色。`,
    `光线：${analysis.style}。全段保持同一光向与色温。`,
    '',
    '[镜头]',
    shots,
    '',
    '[风格]',
    `${analysis.style}；镜头运动缓慢、有目的，不为追动作而失焦。`,
    '',
    '[输出要求]',
    '画面干净，主体清晰，单镜一个主动作；主体面部与产品外观稳定，不出现多余肢体；画面内不出现文字、字幕、Logo 与水印。',
  ]
  return lines.join('\n')
}

/** 首帧图提示词：产品图 + 这一段的第一个镜头画面。 */
export function buildKeyframePrompt(input: {
  segment: Segment
  product: ProductBrief
  style: string
}): string {
  const first = input.segment.shots[0]
  const visual = first === undefined ? '产品特写' : first.visual
  return [
    `竖屏 9:16 商业短视频首帧。画面内容：${visual}。`,
    `产品：${input.product.name}，外观以参考图为准，不要改变产品形状、标签与配色。`,
    `风格：${input.style}；真实摄影质感，构图干净，主体居中偏下，上方留出字幕空间。`,
    '画面内不要出现任何文字、字幕、Logo 与水印。',
  ].join('\n')
}

export function narrationOf(shot: ScriptShot): string {
  return shot.narration.trim()
}
