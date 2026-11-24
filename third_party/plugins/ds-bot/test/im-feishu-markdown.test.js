import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cardChunks, hasMarkdown, splitByTables, toFeishuMarkdown } from '../src/host/im/feishu-markdown.js'

test('Markdown a text message would show as symbols is recognised', () => {
  for (const text of [
    '## 标题',
    '结论是**可以**',
    '运行 `npm test`',
    '见[文档](https://example.com)',
    '- 第一\n- 第二',
    '1. 第一\n2. 第二',
    '> 引用',
    '前文\n\n---\n\n后文',
    '```js\nlet x = 1\n```',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '~~作废~~',
  ]) assert.equal(hasMarkdown(text), true, text)
})

test('plain text is not taken for Markdown', () => {
  for (const text of [
    '好的，马上处理。',
    '第一行\n第二行',
    '2*3*4 = 24',
    'snake_case_name 和 __init__',
    '价格 -5 元',
    'a | b',
    '#话题 不是标题',
  ]) assert.equal(hasMarkdown(text), false, text)
})

test('headings, lists, links, code and tables reach the card as written', () => {
  const source = '## 标题\n\n- **加粗**与[文档](https://example.com)\n\n```js\nlet x = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
  assert.equal(toFeishuMarkdown(source), source)
})

test('a picture a card cannot fetch becomes a link or a caption; an image key stays', () => {
  assert.equal(toFeishuMarkdown('见 ![分镜](https://example.com/a.png) 图'), '见 [分镜](https://example.com/a.png) 图')
  assert.equal(toFeishuMarkdown('![](https://example.com/a.png)'), '[https://example.com/a.png](https://example.com/a.png)')
  assert.equal(toFeishuMarkdown('截图 ![架构图](/tmp/a.png "标题") 结束'), '截图 ［图片：架构图］ 结束')
  assert.equal(toFeishuMarkdown('![](file:///tmp/a.png)'), '［图片］')
  assert.equal(toFeishuMarkdown('![封面](img_v3_02ab_xyz)'), '![封面](img_v3_02ab_xyz)')
})

test('a picture inside code is left alone', () => {
  const fenced = '```md\n![图](/tmp/a.png)\n```'
  assert.equal(toFeishuMarkdown(fenced), fenced)
  assert.equal(toFeishuMarkdown('写法是 `![图](/tmp/a.png)`，效果 ![图](/tmp/a.png)'), '写法是 `![图](/tmp/a.png)`，效果 ［图片：图］')
  assert.equal(toFeishuMarkdown('``![图](/tmp/a.png) ` 仍是代码``'), '``![图](/tmp/a.png) ` 仍是代码``')
})

test('Markdown is cut where a table past the limit begins', () => {
  const table = n => `| h${n} |\n| --- |\n| ${n} |`
  const six = [1, 2, 3, 4, 5, 6].map(table).join('\n\n')
  assert.deepEqual(splitByTables(six), [[1, 2, 3, 4, 5].map(table).join('\n\n'), table(6)])
  assert.deepEqual(splitByTables([1, 2, 3].map(table).join('\n\n'), 1), [table(1), table(2), table(3)])
  const five = [1, 2, 3, 4, 5].map(table).join('\n\n')
  assert.deepEqual(splitByTables(five), [five])
})

test('a table inside a code fence, a row of dashes among the data and a pipe in code count as no table', () => {
  const fenced = '```\n| a |\n| --- |\n| 1 |\n```'
  assert.deepEqual(splitByTables(`${fenced}\n\n${fenced}`, 1), [`${fenced}\n\n${fenced}`])
  // A data row of dashes is part of its table, not the delimiter of another.
  const dashes = '| a | b |\n| --- | --- |\n| --- | --- |\n| 1 | 2 |'
  assert.deepEqual(splitByTables(dashes, 1), [dashes])
  // A pipe inside a code span divides nothing, so the line above the dashes is no header.
  const coded = '用 `a | b` 表示\n| --- | --- |'
  assert.deepEqual(splitByTables(`${coded}\n\n${coded}`, 1), [`${coded}\n\n${coded}`])
})

test('a code fence cut by the chunk limit is closed and opened again', () => {
  const lines = Array.from({ length: 12 }, (_unused, at) => `const line${at} = ${at}`)
  const chunks = cardChunks(`说明\n\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\n\n结束`, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    const fences = chunk.split('\n').filter(line => line.startsWith('```'))
    assert.equal(fences.length % 2, 0, chunk)
  }
  // Every chunk after the first that continues the code opens with the same fence line.
  assert.ok(chunks[1].startsWith('```js\n'))
  assert.equal(chunks.map(chunk => chunk.split('\n').filter(line => line.startsWith('const line')).length).reduce((sum, count) => sum + count, 0), 12)
})
