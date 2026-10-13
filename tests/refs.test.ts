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
    expect(findIssues('do STEP-10 next', null)).toEqual([])
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
    expect(titled('MET-53 &lt;MET-53&gt; &lt;STEP-10&gt;', { prs: [], issues: ['MET-53'] })).toBe('MET-53')
    expect(titled('Fix MET-5', { prs: [], issues: ['MET-53'] })).toBe('Fix MET-5 <MET-53>')
  })
})

type Answer = 'Add tag' | 'Skip'

// The engine beneath the mod: the app's session server, git, the question
// dialog (answered with `answer`), and the tools a test runs.
const engine = (on: On, start: string, answer: Answer, branch = '') => {
  const titles = app(on, start)
  const asked: string[] = []
  on('process.run', async () => ({ value: { exitCode: 0, stdout: `${branch}\n`, stderr: '' } }) as never)
  on('prompt.submit', async ($, e) => ({ text: e.text }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  on('tool.call', async ($, e) => {
    const ev = e as unknown as Record<string, unknown>
    if (ev.tool === 'AskUserQuestion') {
      const q = (ev.questions as Array<{ question: string }>)[0]?.question ?? ''
      asked.push(q)
      return { result: { questions: ev.questions, answers: { [q]: answer } }, text: answer } as never
    }
    const out = String(ev.command ?? '').includes('gh pr create')
      ? 'https://github.com/octo-org/octo-repo/pull/123\n'
      : 'https://github.com/octo-org/octo-repo/pull/77\n'
    return { result: { stdout: out, stderr: '', interrupted: false }, text: out } as never
  })
  return { titles, asked }
}

const endTurn = ($: unknown) =>
  ($ as { turn: { complete: (i: never) => Promise<unknown> } }).turn.complete(
    { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never,
  )

describe('tagging the title', () => {
  test('opening a PR asks, then tags on approval', async ($, on) => {
    const { titles, asked } = engine(on, 'Fix login', 'Add tag')
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
    expect(titles).toEqual(['Fix login'])
    await endTurn($)
    expect(asked).toEqual(["Tag this session's title with <#123>?"])
    expect(titles.at(-1)).toBe('Fix login <#123>')
  })

  test('a skipped tag is not tagged or asked again', async ($, on) => {
    const { titles, asked } = engine(on, 'Fix login', 'Skip', 'you/met-93-fix-login')
    await endTurn($)
    await endTurn($)
    expect(asked).toEqual(["Tag this session's title with <MET-93>?"])
    expect(titles).toEqual(['Fix login'])
  })

  test('the branch and a prompt are asked about together', async ($, on) => {
    const { titles, asked } = engine(on, 'Fix login', 'Add tag', 'you/met-93-fix-login')
    await $.prompt.submit({ text: 'also covers MET-94' } as never)
    await endTurn($)
    expect(asked).toEqual(["Tag this session's title with <MET-94> <MET-93>?"])
    expect(titles.at(-1)).toBe('Fix login <MET-94> <MET-93>')
  })

  test('other gh commands with PR links are not offered', async ($, on) => {
    const { titles, asked } = engine(on, 'Fix login', 'Add tag')
    await $.tool.call({ tool: 'Bash', command: 'gh pr list' } as never)
    await endTurn($)
    expect(asked).toEqual([])
    expect(titles).toEqual(['Fix login'])
  })

  test('a Linear tool call is offered', async ($, on) => {
    const { titles } = engine(on, 'Fix login', 'Add tag')
    await $.tool.call({ tool: 'mcp__linear__get_issue', id: 'MET-93' } as never)
    await endTurn($)
    expect(titles.at(-1)).toBe('Fix login <MET-93>')
  })

  test('escaped tags from the app are replaced, not doubled', async ($, on) => {
    const titles = app(on, '43 &lt;#225&gt; &lt;#225&gt;')
    await run($, 'refs', 'add #225')
    expect(titles.at(-1)).toBe('43 <#225>')
  })

  test('/refs adds, removes and clears tags without asking', async ($, on) => {
    const { titles, asked } = engine(on, 'Fix login', 'Skip')
    await run($, 'refs', 'add MET-93')
    await run($, 'refs', 'add #12')
    expect(titles.at(-1)).toBe('Fix login <MET-93> <#12>')
    await run($, 'refs', 'remove MET-93')
    expect(titles.at(-1)).toBe('Fix login <#12>')
    const out = await run($, 'refs', 'clear')
    expect(out.text).toContain('Tags cleared')
    expect(titles.at(-1)).toBe('Fix login')
    expect(asked).toEqual([])
  })

  test('team keys limit what gets offered', { options: { linearTeams: 'ENG' } }, async ($, on) => {
    const { titles } = engine(on, 'Fix login', 'Add tag')
    await $.prompt.submit({ text: 'MET-93 and ENG-4' } as never)
    await endTurn($)
    expect(titles.at(-1)).toBe('Fix login <ENG-4>')
  })
})
