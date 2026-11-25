/** 第 4、5 步：参考首帧与分镜视频。都按「段」调用，段是模型的最小计费单元。 */

import { join } from 'node:path'
import type { Config } from '../config.ts'
import { existsSync } from 'node:fs'
import { mapPool } from '../concurrency.ts'
import { ensureDir } from '../files.ts'
import { generateImage } from '../providers/image.ts'
import { generateVideo } from '../providers/video.ts'
import { buildKeyframePrompt } from './prompts.ts'
import type { ProductBrief, ScriptVariant } from './types.ts'

export interface KeyframeOptions {
  config: Config
  variant: ScriptVariant
  product: ProductBrief
  style: string
  productImage?: string
  imagesDir: string
  log: (message: string) => void
  /** 上次已生成的段（文件还在就跳过，不重复付费）。 */
  reuse?: Record<string, string>
  /** 每完成一段回调一次，供上层立即落盘。 */
  onSegment?: (key: string, path: string) => Promise<void> | void
}

/** 每段一张参考首帧；产品图作为参考图传给图片模型。 */
export async function generateKeyframes(options: KeyframeOptions): Promise<Record<string, string>> {
  await ensureDir(options.imagesDir)
  const pairs = await mapPool(options.variant.segments, options.config.concurrency, async segment => {
    const key = String(segment.index)
    const dest = join(options.imagesDir, `seg-${String(segment.index).padStart(2, '0')}.png`)
    const cached = options.reuse?.[key]
    if (cached !== undefined && existsSync(cached)) {
      options.log(`段 ${segment.index}：复用已生成的首帧`)
      return [key, cached] as const
    }
    options.log(`段 ${segment.index}：生成参考首帧`)
    await generateImage(options.config.image, {
      prompt: buildKeyframePrompt({ segment, product: options.product, style: options.style }),
      ...(options.productImage === undefined ? {} : { referencePath: options.productImage }),
    }, dest)
    await options.onSegment?.(key, dest)
    return [key, dest] as const
  })
  return Object.fromEntries(pairs)
}

export interface ClipOptions {
  config: Config
  variant: ScriptVariant
  keyframes: Record<string, string>
  clipsDir: string
  log: (message: string) => void
  reuse?: Record<string, string>
  onSegment?: (key: string, path: string) => Promise<void> | void
}

/** 每段一条视频；首帧图作为 first_frame 参考，保证画面从我们生成的画面开始。 */
export async function generateClips(options: ClipOptions): Promise<Record<string, string>> {
  await ensureDir(options.clipsDir)
  const pairs = await mapPool(options.variant.segments, options.config.concurrency, async segment => {
    const key = String(segment.index)
    const dest = join(options.clipsDir, `seg-${String(segment.index).padStart(2, '0')}.mp4`)
    const cached = options.reuse?.[key]
    if (cached !== undefined && existsSync(cached)) {
      options.log(`段 ${segment.index}：复用已生成的片段`)
      return [key, cached] as const
    }
    const firstFrame = options.keyframes[key]
    options.log(`段 ${segment.index}：提交视频任务（${options.config.video.secondsPerClip}s）`)
    await generateVideo(
      options.config.video,
      {
        prompt: segment.prompt,
        ...(firstFrame === undefined ? {} : { firstFramePath: firstFrame }),
        seconds: options.config.video.secondsPerClip,
        ratio: options.config.video.ratio,
        resolution: options.config.video.resolution,
      },
      dest,
      message => options.log(`段 ${segment.index}：${message}`),
    )
    await options.onSegment?.(key, dest)
    return [key, dest] as const
  })
  return Object.fromEntries(pairs)
}
