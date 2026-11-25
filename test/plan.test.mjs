// --plan：只跑到脚本就停，不能产生任何图片/视频调用（也就是不能花钱）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegAvailable, makeFixtures } from './helpers/fixtures.mjs'
import { startMockGateway } from './helpers/mock-gateway.mjs'

test('--plan 模式：停在脚本，零生成调用', { skip: ffmpegAvailable() ? false : 'ffmpeg 不可用' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'svr-plan-'))
  const fixtures = makeFixtures(join(root, 'fixtures'))
  const gateway = await startMockGateway({ clipPath: fixtures.clip, imagePath: fixtures.image })
  t.after(async () => { await gateway.close() })

  const configPath = join(root, 'config.json')
  writeFileSync(configPath, JSON.stringify({ chat: { frames: 4 }, video: { pollMs: 20 }, image: { size: '360x640' } }), 'utf8')
  Object.assign(process.env, {
    SVR_CONFIG: configPath,
    SVR_DATA_DIR: join(root, 'runs'),
    SVR_CHAT_BASE: gateway.baseUrl, SVR_CHAT_KEY: 'k', SVR_CHAT_MODEL: 'mock-chat',
    SVR_IMAGE_BASE: gateway.baseUrl, SVR_IMAGE_KEY: 'k', SVR_IMAGE_MODEL: 'mock-image',
    SVR_VIDEO_BASE: gateway.baseUrl, SVR_VIDEO_KEY: 'k', SVR_VIDEO_MODEL: 'mock-video',
  })

  const { loadConfig, runPipeline, Logger } = await import('../dist/index.js')
  const config = loadConfig()
  const state = await runPipeline({
    input: { source: fixtures.source, product: { name: '气泡水', sellingPoints: '', audience: '' }, productImage: fixtures.image, planOnly: true },
    config,
    logger: new Logger(),
  })

  assert.equal(state.error, undefined)
  assert.equal(state.steps.find(step => step.id === 'script')?.status, 'done')
  assert.equal(state.steps.find(step => step.id === 'keyframes')?.status, 'pending')
  assert.equal(state.steps.find(step => step.id === 'clips')?.status, 'pending')
  assert.equal(state.steps.find(step => step.id === 'compose')?.status, 'pending')
  assert.equal(state.finalVideo, undefined)

  assert.equal(gateway.calls.image, 0, 'plan 模式不应生成图片')
  assert.equal(gateway.calls.videoCreate, 0, 'plan 模式不应创建视频任务')
  assert.equal(gateway.calls.chat, 2, '拆解 + 仿写各一次')
  assert.equal(state.variants?.length, 3)

  const script = join(config.dataDir, state.id, 'script.json')
  assert.ok(existsSync(script), 'plan 模式应落盘 script.json 供审稿')
})
