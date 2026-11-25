// 纯函数单测：字幕时间、分段、拆解规整、JSON 抠取。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAss, formatAssTime, wrapText } from '../dist/media/ass.js'
import { chunkShots } from '../dist/pipeline/script.js'
import { normalizeAnalysis } from '../dist/pipeline/analyze.js'
import { parseJsonLoose } from '../dist/providers/chat.js'

test('字幕时间戳：按厘秒输出', () => {
  assert.equal(formatAssTime(0), '0:00:00.00')
  assert.equal(formatAssTime(1.5), '0:00:01.50')
  assert.equal(formatAssTime(3661.5), '1:01:01.50')
  assert.equal(formatAssTime(-3), '0:00:00.00')
})

test('字幕折行：超过上限插 \\N', () => {
  assert.equal(wrapText('短句'), '短句')
  const long = wrapText('这是一句超过十四个字的中文字幕文案用来测试折行', 14)
  assert.ok(long.includes('\\N'))
})

test('ASS 结构完整且事件数对得上', () => {
  const ass = buildAss(
    [
      { text: '第一句', startSec: 0, endSec: 2 },
      { text: '', startSec: 2, endSec: 4 },
      { text: '第三句', startSec: 4, endSec: 6 },
    ],
    { fontName: 'Helvetica', fontSize: 14, marginV: 40, playResX: 360, playResY: 640 },
  )
  assert.ok(ass.includes('[Script Info]'))
  assert.ok(ass.includes('PlayResX: 360'))
  const dialogues = ass.split('\n').filter(line => line.startsWith('Dialogue:'))
  assert.equal(dialogues.length, 2, '空文案不应产生事件')
  assert.ok(dialogues[0].includes('0:00:00.00,0:00:02.00'))
})

test('分段：镜头数与秒数双约束', () => {
  const shots = count => Array.from({ length: count }, (_, index) => ({ index: index + 1, narration: '', visual: 'v', durationSec: 2 }))
  assert.deepEqual(chunkShots(shots(6), 5, 15).map(chunk => chunk.length), [5, 1])
  assert.deepEqual(chunkShots(shots(4), 5, 15).map(chunk => chunk.length), [4])
  const long = Array.from({ length: 3 }, (_, index) => ({ index: index + 1, narration: '', visual: 'v', durationSec: 10 }))
  assert.deepEqual(chunkShots(long, 5, 15).map(chunk => chunk.length), [1, 1, 1])
})

test('拆解规整：重排镜号、裁掉越界时间', () => {
  const analysis = normalizeAnalysis({
    title: 't', hook: 'h', score: 130,
    shots: [
      { index: 9, startSec: 5, endSec: 99, visual: '后一镜' },
      { index: 3, startSec: 0, endSec: 2, visual: '前一镜', narration: '口播' },
    ],
  }, 6)
  assert.equal(analysis.score, 100)
  assert.deepEqual(analysis.shots.map(shot => shot.index), [1, 2])
  assert.equal(analysis.shots[0].visual, '前一镜')
  assert.ok(analysis.shots[1].endSec <= 6)
})

test('JSON 抠取：容忍围栏与前后废话', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":2} 以上。'), { a: 2 })
  assert.throws(() => parseJsonLoose('没有 JSON'))
})

test('字幕时间轴：按片段真实时长摊开，而不是脚本估算', async () => {
  const { buildCues } = await import('../dist/pipeline/timeline.js')
  const variant = {
    id: 'A',
    angle: '测试',
    segments: [
      { index: 1, prompt: '', shots: [
        { index: 1, narration: '第一句', visual: 'v', durationSec: 2 },
        { index: 2, narration: '第二句', visual: 'v', durationSec: 2 },
      ] },
      { index: 2, prompt: '', shots: [
        { index: 3, narration: '第三句', visual: 'v', durationSec: 2 },
      ] },
    ],
  }
  // 模型实际只给了 3 秒和 6 秒，与脚本的 4 秒/2 秒都不同
  const cues = buildCues(variant, [3, 6])
  assert.equal(cues[0].startSec, 0)
  assert.ok(Math.abs(cues[0].endSec - 1.5) < 1e-6, `第一句应占 1.5s，实际 ${cues[0].endSec}`)
  assert.ok(Math.abs(cues[1].startSec - 1.5) < 1e-6)
  assert.equal(cues[2].startSec, 3, '第二段必须从第一段真实结束处开始')
  assert.ok(Math.abs(cues[2].endSec - 9) < 1e-6)
})

test('字幕时间轴：拿不到真实时长时退回脚本估算', async () => {
  const { buildCues } = await import('../dist/pipeline/timeline.js')
  const variant = {
    id: 'A', angle: '测试',
    segments: [
      { index: 1, prompt: '', shots: [{ index: 1, narration: '一', visual: 'v', durationSec: 2 }] },
      { index: 2, prompt: '', shots: [{ index: 2, narration: '二', visual: 'v', durationSec: 2 }] },
    ],
  }
  const cues = buildCues(variant, [])
  assert.equal(cues[1].startSec, 2)
})

test('模型截断（JSON 场景）会放大预算重试', async () => {
  const { createServer } = await import('node:http')
  const { completeChat } = await import('../dist/providers/chat.js')
  let calls = 0
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      calls += 1
      const body = calls === 1
        ? { choices: [{ finish_reason: 'length', message: { content: '{"shots":[{"index":1' } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: '{"shots":[{"index":1}]}' } }] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const text = await completeChat(
      { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'm', frames: 4, maxSide: 512, timeoutMs: 5_000 },
      { user: '拆解', json: true, maxTokens: 100 },
    )
    assert.equal(calls, 2, '截断后应重试一次')
    assert.equal(text, '{"shots":[{"index":1}]}')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
