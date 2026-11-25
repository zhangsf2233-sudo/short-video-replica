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
