/** 文件与路径小工具。 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}

/** 先写临时文件再改名，避免中断留下半个 JSON。 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path))
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

export function readJsonIfExists<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
}

/** 本地图片 → data URL（模型接口都支持 base64 直传，省得搭图床）。 */
export async function toDataUrl(path: string): Promise<string> {
  const mime = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const buffer = await readFile(path)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

/** 生成运行 ID：时间戳 + 4 位随机，天然按时间排序。 */
export function newRunId(now = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const noise = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${noise}`
}

/** 文件名安全化（中文保留，只干掉路径分隔符和控制字符）。 */
export function safeName(value: string): string {
  return value.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)
}

export function runPaths(dataDir: string, runId: string): {
  root: string
  frames: string
  images: string
  clips: string
  final: string
  state: string
} {
  const root = join(dataDir, runId)
  return {
    root,
    frames: join(root, 'frames'),
    images: join(root, 'images'),
    clips: join(root, 'clips'),
    final: join(root, 'final.mp4'),
    state: join(root, 'run.json'),
  }
}
