#!/usr/bin/env node
/**
 * 零成本演示：本地 mock 网关 + ffmpeg 现场生成素材，跑完整条六步流水线。
 * 不需要任何 API Key，产物落在 ./output/demo/，用来快速看效果或给 CI 用。
 *
 * 用法：npm run demo
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtures, ffmpegAvailable } from '../test/helpers/fixtures.mjs'
import { startMockGateway } from '../test/helpers/mock-gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const output = join(repo, 'output', 'demo')

if (!ffmpegAvailable()) {
  console.error('✗ 需要 ffmpeg：brew install ffmpeg')
  process.exit(1)
}

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
console.log('→ 生成测试素材')
const fixtures = makeFixtures(join(output, 'fixtures'))

const gateway = await startMockGateway({ clipPath: fixtures.clip, imagePath: fixtures.image })
console.log(`→ mock 网关已启动：${gateway.baseUrl}`)

const configPath = join(output, 'config.json')
writeFileSync(configPath, JSON.stringify({
  image: { size: '720x1280' },
  chat: { frames: 6 },
  video: { secondsPerClip: 5, pollMs: 20, timeoutMs: 30_000 },
  subtitle: { enabled: true, fontName: 'PingFang SC', fontSize: 44, marginV: 150 },
}, null, 2))

Object.assign(process.env, {
  SVR_CONFIG: configPath,
  SVR_DATA_DIR: join(output, 'runs'),
  SVR_CHAT_BASE: gateway.baseUrl,
  SVR_CHAT_KEY: 'mock',
  SVR_CHAT_MODEL: 'mock-vision',
  SVR_IMAGE_BASE: gateway.baseUrl,
  SVR_IMAGE_KEY: 'mock',
  SVR_IMAGE_MODEL: 'mock-image',
  SVR_VIDEO_BASE: gateway.baseUrl,
  SVR_VIDEO_KEY: 'mock',
  SVR_VIDEO_MODEL: 'mock-video',
})

const { loadConfig, runPipeline, Logger } = await import('../dist/index.js')
const config = loadConfig()
const state = await runPipeline({
  input: {
    source: fixtures.source,
    product: { name: '橙色气泡水', sellingPoints: '九块九一罐', audience: '上班族' },
    productImage: fixtures.image,
  },
  config,
  logger: new Logger(),
})
await gateway.close()

const duration = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', state.finalVideo], { encoding: 'utf8' })
console.log('')
console.log(`✓ 成片：${state.finalVideo}`)
console.log(`  时长：${Number(duration.stdout.trim()).toFixed(2)}s，段数：${Object.keys(state.clips).length}`)
console.log(`  运行状态：${join(config.dataDir, state.id, 'run.json')}`)
