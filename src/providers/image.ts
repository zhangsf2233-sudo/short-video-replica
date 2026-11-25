/** 图片生成适配（OpenAI 风格 /images/generations，兼容火山方舟 seedream）。 */

import { writeFile } from 'node:fs/promises'
import { download, requestJson } from '../http.ts'
import type { ImageConfig } from '../config.ts'
import { toDataUrl } from '../files.ts'

export interface ImageRequest {
  prompt: string
  /** 参考图：产品图或上一镜的末帧。 */
  referencePath?: string
  size?: string
}

interface ImageResponse {
  data?: Array<{ url?: string, b64_json?: string, image_url?: string }>
  error?: { message?: string }
}

export async function generateImage(config: ImageConfig, request: ImageRequest, destPath: string): Promise<void> {
  if (config.model.trim() === '') throw new Error('没有配置图片模型（VFLOW_IMAGE_MODEL 或配置文件 image.model）')

  const body: Record<string, unknown> = {
    model: config.model,
    prompt: request.prompt,
    size: request.size ?? config.size,
    response_format: 'url',
  }
  if (request.referencePath !== undefined) {
    // 参考图直接给 data URL：网关普遍支持，不需要图床。
    body.image = await toDataUrl(request.referencePath)
  }

  const payload = await requestJson<ImageResponse>({
    url: `${config.baseUrl.replace(/\/+$/, '')}/images/generations`,
    apiKey: config.apiKey,
    body,
    timeoutMs: config.timeoutMs,
    retries: 2,
  })

  const first = payload.data?.[0]
  if (first === undefined) throw new Error(`图片接口没有返回 data：${payload.error?.message ?? '未知原因'}`)

  const url = first.url ?? first.image_url
  if (typeof url === 'string' && url !== '') {
    await download(url, destPath)
    return
  }
  if (typeof first.b64_json === 'string' && first.b64_json !== '') {
    await writeFile(destPath, Buffer.from(first.b64_json, 'base64'))
    return
  }
  throw new Error('图片响应里既没有 url 也没有 b64_json')
}
