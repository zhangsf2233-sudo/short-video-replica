// 端到端：真 ffmpeg + 本地 mock 网关，跑完六步，断言成片时长与调用次数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegAvailable, makeFixtures, FFMPEG } from './helpers/fixtures.mjs'
import { startMockGateway } from './helpers/mock-gateway.mjs'

function durationOf(path) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return Number(result.stdout.trim())
}

test('端到端：源片 → 拆解 → 脚本 → 首帧 → 分镜 → final.mp4', { skip: ffmpegAvailable() ? false : 'ffmpeg 不可用' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'vflow-e2e-'))
  const fixtures = makeFixtures(join(root, 'fixtures'))
  const gateway = await startMockGateway({ clipPath: fixtures.clip, imagePath: fixtures.image })

  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    image: { size: '360x640' },
    chat: { frames: 4 },
    video: { secondsPerClip: 5, pollMs: 20, timeoutMs: 30_000 },
    subtitle: { enabled: true, fontName: 'Helvetica', fontSize: 14, marginV: 40 },
  }), 'utf8')

  process.env.VFLOW_CONFIG = configPath
  process.env.VFLOW_DATA_DIR = join(root, 'runs')
  process.env.VFLOW_CHAT_BASE = gateway.baseUrl
  process.env.VFLOW_CHAT_KEY = 'test-key'
  process.env.VFLOW_CHAT_MODEL = 'mock-chat'
  process.env.VFLOW_IMAGE_BASE = gateway.baseUrl
  process.env.VFLOW_IMAGE_KEY = 'test-key'
  process.env.VFLOW_IMAGE_MODEL = 'mock-image'
  process.env.VFLOW_VIDEO_BASE = gateway.baseUrl
  process.env.VFLOW_VIDEO_KEY = 'test-key'
  process.env.VFLOW_VIDEO_MODEL = 'mock-video'

  t.after(async () => { await gateway.close() })

  const { loadConfig, runPipeline, Logger } = await import('../dist/index.js')
  const config = loadConfig()
  const logger = new Logger()

  const input = {
    source: fixtures.source,
    product: { name: '橙色气泡水', sellingPoints: '九块九一罐', audience: '上班族' },
    productImage: fixtures.image,
    frames: 4,
  }

  const state = await runPipeline({ input, config, logger })

  assert.equal(state.error, undefined, `流水线报错：${state.error}`)
  assert.deepEqual(state.steps.map(step => step.status), ['done', 'done', 'done', 'done', 'done', 'done'])
  assert.ok(state.analysis !== undefined)
  assert.equal(state.analysis.shots.length, 3)
  assert.equal(state.variants?.length, 3)
  assert.equal(state.chosenVariant, 'A')

  // 6 个镜头按「≤5 镜」切成 2 段，每段 5 秒
  assert.equal(Object.keys(state.clips).length, 2)
  assert.ok(state.finalVideo !== undefined && existsSync(state.finalVideo))

  const duration = durationOf(state.finalVideo)
  assert.ok(Math.abs(duration - 10) < 1.5, `成片时长应约 10s，实际 ${duration}`)
  assert.ok(existsSync(join(config.dataDir, state.id, 'run.json')))

  assert.equal(gateway.calls.chat, 2, '一次拆解 + 一次仿写')
  assert.equal(gateway.calls.image, 2, '两段各一张首帧')
  assert.equal(gateway.calls.videoCreate, 2)

  // resume：已完成步骤不再重复调用模型
  const before = { ...gateway.calls }
  const resumed = await runPipeline({ input, config, logger: new Logger(), runId: state.id, resume: true })
  assert.equal(resumed.finalVideo, state.finalVideo)
  assert.equal(gateway.calls.chat, before.chat, 'resume 不应重新调用对话模型')
  assert.equal(gateway.calls.image, before.image, 'resume 不应重新生成首帧')
})
