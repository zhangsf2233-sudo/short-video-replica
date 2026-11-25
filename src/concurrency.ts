/**
 * 有界并发：视频/图片生成是网络等待型任务，串行跑 5 段等于等 5 次。
 * 但也不能无限并发——上游网关通常有速率限制，且并发过高反而更容易失败。
 */

/** 按输入顺序返回结果；某个任务失败后不再派发新任务，等在途任务结束后抛第一个错误。 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let cursor = 0
  let failure: unknown

  const run = async (): Promise<void> => {
    for (;;) {
      if (failure !== undefined) return
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await worker(items[index] as T, index)
      } catch (error) {
        if (failure === undefined) failure = error
        return
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, run))
  if (failure !== undefined) throw failure
  return results
}
