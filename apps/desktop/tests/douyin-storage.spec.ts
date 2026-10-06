import { expect, it } from 'vitest'
import { douyinStorageNavigation, douyinStoragePartition } from '../src/douyin-storage.ts'

const url = 'https://www.douyin.com/video/7692443246022167851'
it('retains Douyin login per workspace across process restart and video links', () => {
  const partition = douyinStoragePartition('cwd:/first', url)
  expect(partition).toMatch(/^persist:muse-douyin-[a-f0-9]{64}$/)
  expect(douyinStoragePartition('cwd:/first', 'https://v.douyin.com/zz584KwAVaA/')).toBe(partition)
  expect(douyinStoragePartition('cwd:/first', 'https://creator.douyin.com/')).toBe(partition)
  expect(douyinStoragePartition('cwd:/second', url)).not.toBe(partition)
  expect(partition).not.toContain('/first')
})
it('keeps unrelated tabs ephemeral and prevents persistent tabs leaving official HTTPS pages', () => {
  for (const value of [undefined, 42, 'https://example.com/', 'https://www.douyin.com.evil.test/video/7692443246022167851']) {
    expect(douyinStoragePartition('cwd:/first', value)).toBeUndefined()
  }
  expect(douyinStorageNavigation(url)).toBe(true)
  expect(douyinStorageNavigation('https://www.douyin.com/')).toBe(true)
  expect(douyinStorageNavigation('https://creator.douyin.com/creator-micro/content/manage')).toBe(true)
  for (const value of ['http://www.douyin.com/', 'https://www.douyin.com:9443/', 'https://user:pass@www.douyin.com/', 'https://creator.douyin.com.evil.test/', 'https://example.com/', 'file:///tmp/']) {
    expect(douyinStorageNavigation(value)).toBe(false)
  }
})
