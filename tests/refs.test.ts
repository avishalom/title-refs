import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findIssues, findPulls, titled } from '../hooks/register'

const app = (on: On, start: string) => {
  const titles: string[] = [start]
  on('session.id', async () => ({ value: 'sess-1' }))
  on('session.cwd', async () => ({ value: '/tmp/repo' }))
  mock.store(on)
  on('mcp.call', async ($, e) => {
    if (e.tool === 'get_session') {
      const title = titles.at(-1)
      return { value: { content: [{ type: 'text', text: JSON.stringify({ title }) }], isError: false } }
    }
    titles.push(String(e.args.title))
    return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  return titles
}

const run = ($: unknown, command: string, args: string) =>
  ($ as { command: { run: (i: never) => Promise<{ text?: string }> } }).command.run({ command, args } as never)

describe('finding refs', () => {
  test('issue keys in prompts, branches and look-alikes', () => {
    expect(findIssues('please pick up MET-93 and MET-101', null)).toEqual(['MET-93', 'MET-101'])
    expect(findIssues('save it as UTF-8, per ISO-9001 and RFC-2119', null)).toEqual([])
    expect(findIssues('lowercase met-93 in a prompt', null)).toEqual([])
    expect(findIssues('avishalomshalit/met-81-feature-vdi-to-sop', null, true)).toEqual(['MET-81'])
    expect(findIssues('fix-12-typo', null, true)).toEqual([])
    expect(findIssues('ENG-4 and MET-9', new Set(['MET']))).toEqual(['MET-9'])
  })

  test('PR numbers from gh output', () => {
    expect(findPulls('https://github.com/octo-org/octo-repo/pull/123\n')).toEqual([123])
    expect(findPulls('no link here')).toEqual([])
  })

  test('title tags replace old ones at the end', () => {
    expect(titled('Fix login', { prs: [123], issues: ['MET-93'] })).toBe('Fix login <MET-93> <#123>')
    expect(titled('Fix login <MET-93> <#123>', { prs: [123, 130], issues: ['MET-93'] }))
      .toBe('Fix login <MET-93> <#123> <#130>')
    expect(titled('🟦 Fix login <MET-93> · 📝 note', { prs: [], issues: ['MET-93'] }))
      .toBe('🟦 Fix login · 📝 note <MET-93>')
    expect(titled('Fix login <MET-93>', { prs: [], issues: [] })).toBe('Fix login')
  })
})

describe('tagging the title', () => {
  test('a prompt naming an issue tags the title', async ($, on) => {
    const titles = app(on, 'Fix login')
    on('prompt.submit', async ($, e) => ({ text: e.text }) as never)
    await $.prompt.submit({ text: 'work on MET-93 please' } as never)
    expect(titles.at(-1)).toBe('Fix login <MET-93>')
  })

  test('gh pr create tags the PR number', async ($, on) => {
    const titles = app(on, 'Fix login')
    on('tool.call', async () => ({
      result: { stdout: 'https://github.com/octo-org/octo-repo/pull/123\n', stderr: '', interrupted: false },
      text: 'https://github.com/octo-org/octo-repo/pull/123',
    }) as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
    expect(titles.at(-1)).toBe('Fix login <#123>')
  })

  test('other commands with PR links do not tag', async ($, on) => {
    const titles = app(on, 'Fix login')
    on('tool.call', async () => ({
      result: { stdout: 'https://github.com/o/r/pull/77', stderr: '', interrupted: false },
      text: 'https://github.com/o/r/pull/77',
    }) as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr list' } as never)
    expect(titles).toEqual(['Fix login'])
  })

  test('a Linear tool call tags its issue', async ($, on) => {
    const titles = app(on, 'Fix login')
    on('tool.call', async () => ({ result: { content: [] }, text: 'ok' }) as never)
    await $.tool.call({ tool: 'mcp__linear__get_issue', id: 'MET-93' } as never)
    expect(titles.at(-1)).toBe('Fix login <MET-93>')
  })

  test('/refs adds, removes and clears tags', async ($, on) => {
    const titles = app(on, 'Fix login')
    await run($, 'refs', 'add MET-93')
    await run($, 'refs', 'add #12')
    expect(titles.at(-1)).toBe('Fix login <MET-93> <#12>')
    await run($, 'refs', 'remove MET-93')
    expect(titles.at(-1)).toBe('Fix login <#12>')
    const out = await run($, 'refs', 'clear')
    expect(out.text).toContain('Tags cleared')
    expect(titles.at(-1)).toBe('Fix login')
  })

  test('team keys limit what gets tagged', { options: { linearTeams: 'ENG' } }, async ($, on) => {
    const titles = app(on, 'Fix login')
    on('prompt.submit', async ($, e) => ({ text: e.text }) as never)
    await $.prompt.submit({ text: 'MET-93 and ENG-4' } as never)
    expect(titles.at(-1)).toBe('Fix login <ENG-4>')
  })
})
