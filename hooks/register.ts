import type { EngineInterface, Register } from 'claude-code'

const SERVER = 'ccd_session_mgmt'
const MAX_TAGS = 4

export type Refs = { prs: number[]; issues: string[] }

const EMPTY: Refs = { prs: [], issues: [] }

// Prefixes that look like issue keys but are standards, encodings or branch words.
const NOT_ISSUES = new Set([
  'UTF', 'ISO', 'SHA', 'MD', 'RFC', 'CVE', 'HTTP', 'TLS', 'SSL', 'ES', 'GPT', 'PEP',
  'FIX', 'BUG', 'HOTFIX', 'FEAT', 'FEATURE', 'RELEASE', 'V', 'TASK', 'WIP', 'PR', 'X',
  'IPV', 'H', 'COVID', 'MP', 'AES', 'RSA', 'ECMA', 'ANSI', 'WCAG', 'CSS', 'HTML', 'TOP',
])

const ISSUE = /(?<![A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,6})(?![A-Za-z0-9])/g
const UPPER_ISSUE = /(?<![A-Za-z0-9])([A-Z]{2,6})-(\d{1,6})(?![A-Za-z0-9])/g
const PULL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g
const TAG = /\s*<(?:#\d+|[A-Z]{2,6}-\d+)>/g

const teamsFrom = (raw: unknown): Set<string> | null => {
  const keys = String(raw ?? '')
    .split(/[\s,]+/)
    .map(k => k.trim().toUpperCase())
    .filter(Boolean)
  return keys.length ? new Set(keys) : null
}

// Issue keys in text. Prompts need upper case (MET-93); branch names are lower case.
export const findIssues = (text: string, teams: Set<string> | null, anyCase = false): string[] => {
  const found: string[] = []
  for (const m of text.matchAll(anyCase ? ISSUE : UPPER_ISSUE)) {
    const key = (m[1] ?? '').toUpperCase()
    const id = `${key}-${Number(m[2])}`
    if (teams ? !teams.has(key) : NOT_ISSUES.has(key)) continue
    if (!found.includes(id)) found.push(id)
  }
  return found
}

export const findPulls = (text: string): number[] => {
  const found: number[] = []
  for (const m of text.matchAll(PULL)) {
    const n = Number(m[1])
    if (!found.includes(n)) found.push(n)
  }
  return found
}

// "<base> <MET-93> <#123>": the base with any old tags removed, then the tags.
export const titled = (title: string, refs: Refs): string => {
  const base = title.replace(TAG, '').trimEnd()
  const tags = [...refs.issues, ...refs.prs.map(n => `#${n}`)].slice(-MAX_TAGS)
  return tags.length ? `${base} ${tags.map(t => `<${t}>`).join(' ')}` : base
}

const merge = (refs: Refs, add: Partial<Refs>): Refs => ({
  prs: [...refs.prs, ...(add.prs ?? []).filter(n => !refs.prs.includes(n))],
  issues: [...refs.issues, ...(add.issues ?? []).filter(i => !refs.issues.includes(i))],
})

const key = async ($: EngineInterface) => `refs:${await $.session.id()}`

const load = async ($: EngineInterface): Promise<Refs> =>
  ((await $.store.get(await key($))) as Refs | undefined) ?? EMPTY

const save = async ($: EngineInterface, refs: Refs) => {
  if (refs.prs.length || refs.issues.length) await $.store.set(await key($), refs)
  else await $.store.delete(await key($))
}

const textOf = (res: { content: ReadonlyArray<{ type: string }> }): string =>
  res.content.map(b => ('text' in b ? String(b.text) : '')).join('\n')

// Rewrites the title only when it differs, so the app isn't asked needlessly.
const sync = async ($: EngineInterface): Promise<string> => {
  try {
    const got = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
    if (got.isError) return 'session title unavailable'
    const title = JSON.parse(textOf(got) || '{}').title
    if (typeof title !== 'string') return 'session title unavailable'
    const next = titled(title, await load($))
    if (next === title) return 'title already up to date'
    const set = await $.mcp.call(SERVER, 'set_session_title', { session_id: 'self', title: next })
    return set.isError ? 'the app declined the rename' : `title: ${next}`
  } catch {
    return 'the app session server is not reachable'
  }
}

const add = async ($: EngineInterface, found: Partial<Refs>) => {
  if (!found.prs?.length && !found.issues?.length) return
  const before = await load($)
  const after = merge(before, found)
  if (after.prs.length === before.prs.length && after.issues.length === before.issues.length) return
  await save($, after)
  await sync($)
}

// Tagging is a side effect: it must never fail the prompt or tool call it rides on.
const quietly = async (work: () => Promise<unknown>) => {
  try {
    await work()
  } catch {
    // ignored
  }
}

const branchIssues = async ($: EngineInterface, teams: Set<string> | null): Promise<string[]> => {
  try {
    const run = await $.process.run(['git', 'branch', '--show-current'], {
      cwd: await $.session.cwd(),
      timeoutMs: 3000,
    })
    return run.exitCode === 0 ? findIssues(run.stdout.trim(), teams, true) : []
  } catch {
    return []
  }
}

export const register: Register = (on, options) => {
  const teams = teamsFrom(options.linearTeams)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'refs',
      description: 'Show the PR and Linear tags on this session\'s title; add or remove one, or clear them',
      argumentHint: '[add MET-93 | add #123 | remove <tag> | clear]',
      immediate: true,
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const ran = await next(e)
    await quietly(() => add($, { issues: findIssues(e.text, teams) }))
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ('deny' in ran && ran.deny) return ran
    // The tool's own arguments sit beside the reserved keys on the event.
    const { tool: _tool, tool_use_id: _id, consent: _consent, ...args } = e as Record<string, unknown>
    const input = JSON.stringify(args)
    const output = ran.text ?? ''
    const isPrCreate =
      (e.tool === 'Bash' && /\bgh\s+pr\s+create\b/.test(input)) ||
      /create_pull_request|bind_pr/i.test(e.tool)
    if (isPrCreate && !ran.isError) await quietly(() => add($, { prs: findPulls(`${input}\n${output}`) }))
    if (/linear/i.test(e.tool)) await quietly(() => add($, { issues: findIssues(input, teams) }))
    return ran
  })

  // Reapply after session-note rewrites the title, and pick up the branch.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    if (e.command === 'note' || e.command === 'note-color') await quietly(() => sync($))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      const issues = await branchIssues($, teams)
      if (issues.length) await add($, { issues })
      else await sync($)
    })
    return next(e)
  })

  on('command.run', { command: 'refs' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const refs = await load($)
    const show = (r: Refs) =>
      [...r.issues, ...r.prs.map(n => `#${n}`)].map(t => `<${t}>`).join(' ') || 'no tags'

    if (!verb) return { text: `Tags: ${show(refs)}` }
    if (verb === 'clear') {
      await save($, EMPTY)
      return { text: `Tags cleared; ${await sync($)}.` }
    }
    const pr = /^#?(\d+)$/.exec(arg)
    const issue = findIssues(arg.toUpperCase(), null)[0] ?? (/^[A-Z]{2,6}-\d+$/i.test(arg) ? arg.toUpperCase() : null)
    if (verb === 'add' && (pr || issue)) {
      const next = merge(refs, pr ? { prs: [Number(pr[1])] } : { issues: [issue as string] })
      await save($, next)
      return { text: `Tags: ${show(next)}; ${await sync($)}.` }
    }
    if (verb === 'remove' && (pr || issue)) {
      const next: Refs = {
        prs: refs.prs.filter(n => !pr || n !== Number(pr[1])),
        issues: refs.issues.filter(i => !issue || i !== issue),
      }
      await save($, next)
      return { text: `Tags: ${show(next)}; ${await sync($)}.` }
    }
    return { text: 'Usage: /refs, /refs add MET-93, /refs add #123, /refs remove <tag>, /refs clear' }
  })
}
