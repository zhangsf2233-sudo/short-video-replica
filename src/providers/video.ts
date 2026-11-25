/**
 * 视频生成适配：火山方舟 Seedance 的任务式接口（创建 → 轮询 → 下载）。
 *
 * 为什么用任务接口而不是同步接口：单段视频要几十秒到几分钟，同步请求几乎必然超时。
 */

import { download, requestJson } from '../http.ts'
import type { VideoConfig } from '../config.ts'
import { toDataUrl } from '../files.ts'

export interface VideoRequest {
  prompt: string
  /** 首帧参考图：让每一段的起始画面受控。 */
  firstFramePath?: string
  seconds: number
  ratio: string
  resolution: string
}

interface CreateTaskResponse {
  id?: string
  task_id?: string
  data?: { id?: string }
  error?: { message?: string }
}

interface TaskStatusResponse {
  id?: string
  status?: string
  state?: string
  content?: { video_url?: string }
  video_url?: string
  data?: { status?: string, video_url?: string, content?: { video_url?: string } }
  error?: { message?: string, code?: string }
}

const SUCCESS = new Set(['succeeded', 'succeed', 'success', 'completed', 'done'])
const FAILED = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled'])

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export async function generateVideo(
  config: VideoConfig,
  request: VideoRequest,
  destPath: string,
  log?: (message: string) => void,
): Promise<void> {
  if (config.model.trim() === '') throw new Error('没有配置视频模型（VFLOW_VIDEO_MODEL 或配置文件 video.model）')
  const base = config.baseUrl.replace(/\/+$/, '')

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: request.prompt }]
  if (request.firstFramePath !== undefined) {
    content.push({
      type: 'image_url',
      image_url: { url: await toDataUrl(request.firstFramePath) },
      role: 'first_frame',
    })
  }

  const created = await requestJson<CreateTaskResponse>({
    url: `${base}/contents/generations/tasks`,
    apiKey: config.apiKey,
    timeoutMs: 120_000,
    retries: 2,
    body: {
      model: config.model,
      content,
      duration: request.seconds,
      ratio: request.ratio,
      resolution: request.resolution,
    },
  })

  const taskId = created.id ?? created.task_id ?? created.data?.id
  if (typeof taskId !== 'string' || taskId === '') {
    throw new Error(`视频任务创建失败：${created.error?.message ?? JSON.stringify(created).slice(0, 300)}`)
  }
  log?.(`任务 ${taskId} 已提交`)

  const deadline = Date.now() + config.timeoutMs
  while (Date.now() < deadline) {
    await sleep(config.pollMs)
    const task = await requestJson<TaskStatusResponse>({
      url: `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      method: 'GET',
      apiKey: config.apiKey,
      timeoutMs: 60_000,
      retries: 3,
    })
    const status = (task.status ?? task.state ?? task.data?.status ?? '').toLowerCase()
    if (SUCCESS.has(status)) {
      const url = task.content?.video_url ?? task.data?.content?.video_url ?? task.video_url ?? task.data?.video_url
      if (typeof url !== 'string' || url === '') throw new Error('任务成功但没有返回 video_url')
      await download(url, destPath)
      log?.(`已下载 ${destPath}`)
      return
    }
    if (FAILED.has(status)) {
      throw new Error(`视频任务失败：${task.error?.message ?? status}`)
    }
    log?.(`等待中（${status === '' ? 'unknown' : status}）`)
  }
  throw new Error(`视频任务超时（${Math.round(config.timeoutMs / 1000)}s）`)
}
