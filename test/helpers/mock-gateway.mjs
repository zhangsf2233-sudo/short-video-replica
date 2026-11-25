// 本地 mock 网关：模拟对话 / 图片 / 视频三类接口，行为与真实服务同构，
// 但不出网、不花钱，因此 CI 里也能跑完整条流水线。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

function analyzePayload() {
  return {
    title: '九块九下午茶', hook: '开场直接把价格怼到镜头前',
    structure: ['价格钩子', '产品特写', '使用场景', '行动号召'],
    rhythm: '镜头 2 秒一切', style: '暖白背景，真实摄影', viralDna: '低价 + 即时满足',
    score: 82, summary: '结构标准，钩子在前 2 秒',
    shots: [
      { index: 1, startSec: 0, endSec: 2, visual: '橙色易拉罐入画', action: '手放入画面', narration: '下午茶选它只要九块九', camera: '特写固定' },
      { index: 2, startSec: 2, endSec: 4, visual: '罐身橙色高光', action: '缓慢旋转', narration: '', camera: '微距横移' },
      { index: 3, startSec: 4, endSec: 6, visual: '手持举杯', action: '抬手喝一口', narration: '打工人续命', camera: '中近景' },
    ],
  }
}

function scriptPayload() {
  const shots = count => Array.from({ length: count }, (_, index) => ({
    narration: index === 0 ? '下午茶选它只要九块九' : `卖点 ${index + 1}`,
    visual: `镜头 ${index + 1}：暖白背景，橙色易拉罐，手部动作清晰`,
    durationSec: 2,
  }))
  return {
    variants: [
      { id: 'A', angle: '忠实原结构', segments: [{ shots: shots(6) }] },
      { id: 'B', angle: '反差悬念', segments: [{ shots: shots(4) }] },
      { id: 'C', angle: '换人群', segments: [{ shots: shots(4) }] },
    ],
  }
}

export async function startMockGateway(options) {
  const clip = readFileSync(options.clipPath)
  const image = readFileSync(options.imagePath)
  const calls = { chat: 0, image: 0, videoCreate: 0, videoPoll: 0 }
  let taskSeq = 0
  let baseUrl = ''

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const json = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }

      if (request.method === 'POST' && request.url === '/chat/completions') {
        calls.chat += 1
        const askingAnalysis = body.includes('截图') || body.includes('系统提示的 JSON 结构')
        const content = askingAnalysis ? JSON.stringify(analyzePayload()) : JSON.stringify(scriptPayload())
        return json(200, { choices: [{ finish_reason: 'stop', message: { content } }] })
      }

      if (request.method === 'POST' && request.url === '/images/generations') {
        calls.image += 1
        return json(200, { data: [{ b64_json: image.toString('base64') }] })
      }

      if (request.method === 'POST' && request.url === '/contents/generations/tasks') {
        calls.videoCreate += 1
        taskSeq += 1
        return json(200, { id: `task-${taskSeq}` })
      }

      if (request.method === 'GET' && request.url?.startsWith('/contents/generations/tasks/')) {
        calls.videoPoll += 1
        return json(200, { status: 'succeeded', content: { video_url: `${baseUrl}/assets/clip.mp4` } })
      }

      if (request.method === 'GET' && request.url === '/assets/clip.mp4') {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(clip.byteLength) })
        return response.end(clip)
      }

      return json(404, { error: { message: `mock 没有实现 ${request.method} ${request.url}` } })
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    calls,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
