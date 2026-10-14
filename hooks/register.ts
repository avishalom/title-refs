import type { EngineInterface, Register } from 'claude-code'

const SERVER = 'ccd_session_mgmt'
const MAX_TAGS = 4

export type Refs = { prs: number[]; issues: string[]; declined?: string[] }

const EMPTY: Refs = { prs: [], issues: [] }

// Prefixes that look like issue keys but are standards, encodings or branch words.
const NOT_ISSUES = new Set([
  'UTF', 'ISO', 'SHA', 'MD', 'RFC', 'CVE', 'HTTP', 'TLS', 'SSL', 'ES', 'GPT', 'PEP',
  'FIX', 'BUG', 'HOTFIX', 'FEAT', 'FEATURE', 'RELEASE', 'V', 'TASK', 'WIP', 'PR', 'X',
  'IPV', 'H', 'COVID', 'MP', 'AES', 'RSA', 'ECMA', 'ANSI', 'WCAG', 'CSS', 'HTML', 'TOP',
  'STEP', 'PHASE', 'PART', 'ROUND', 'PAGE', 'LINE', 'ITEM', 'DAY', 'WEEK', 'SPRINT', 'TEST',
])

const ISSUE = /(?<![A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,6})(?![A-Za-z0-9])/g
const UPPER_ISSUE = /(?<![A-Za-z0-9])([A-Z]{2,6})-(\d{1,6})(?![A-Za-z0-9])/g
const PULL = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g
// The app may hand titles back with < and > escaped, so match both spellings.
const TAG = /\s*(?:<|&lt;)(?:#\d+|[A-Z]{2,6}-\d+)(?:>|&gt;)/g

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

// True only when the command itself runs `gh pr create`, alone or after simple
// `cd …` / `export …` steps, not when it merely mentions it (a heredoc, a grep).
export const runsPrCreate = (command: string): boolean =>
  /^\s*(?:(?:cd|export)\s+[^;&|\n]+?\s*&&\s*)*gh\s+pr\s+create\b/.test(command)

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
  const inBase = (id: string) => new RegExp(`(?<![A-Za-z0-9])${id}(?![0-9])`, 'i').test(base)
  const tags = [...refs.issues.filter(i => !inBase(i)), ...refs.prs.map(n => `#${n}`)].slice(-MAX_TAGS)
  return tags.length ? `${base} ${tags.map(t => `<${t}>`).join(' ')}` : base
}

const merge = (refs: Refs, add: Partial<Refs>): Refs => ({
  ...refs,
  prs: [...refs.prs, ...(add.prs ?? []).filter(n => !refs.prs.includes(n))],
  issues: [...refs.issues, ...(add.issues ?? []).filter(i => !refs.issues.includes(i))],
})

const label = (tag: string) => `<${tag}>`

const key = async ($: EngineInterface) => `refs:${await $.session.id()}`

const load = async ($: EngineInterface): Promise<Refs> =>
  ((await $.store.get(await key($))) as Refs | undefined) ?? EMPTY

const save = async ($: EngineInterface, refs: Refs) => {
  if (refs.prs.length || refs.issues.length || refs.declined?.length) await $.store.set(await key($), refs)
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

// Refs spotted during a turn, asked about once the turn ends.
let spotted: Partial<Refs> = {}

const spot = (found: Partial<Refs>) => {
  spotted = merge({ prs: spotted.prs ?? [], issues: spotted.issues ?? [] }, found)
}

// Asks once for every new ref, then tags the title with the ones approved.
const offer = async ($: EngineInterface, found: Partial<Refs>) => {
  const refs = await load($)
  const declined = refs.declined ?? []
  const fresh = [
    ...(found.issues ?? []).filter(i => !refs.issues.includes(i) && !declined.includes(i)),
    ...(found.prs ?? []).map(n => `#${n}`).filter(t => !refs.prs.includes(Number(t.slice(1))) && !declined.includes(t)),
  ]
  if (!fresh.length) {
    await sync($)
    return
  }
  const tags = fresh.map(label).join(' ')
  let answer = 'Skip'
  try {
    answer = await $.ui.ask(`Tag this session's title with ${tags}?`, { options: ['Add tag', 'Skip'], header: 'Title tag' })
  } catch {
    return // dismissed, or nobody to ask: ask again next time
  }
  const isYes = answer === 'Add tag'
  const prs = fresh.filter(t => t.startsWith('#')).map(t => Number(t.slice(1)))
  const issues = fresh.filter(t => !t.startsWith('#'))
  const next = isYes ? merge(refs, { prs, issues }) : { ...refs, declined: [...declined, ...fresh] }
  await save($, next)
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
    spot({ issues: findIssues(e.text, teams) })
    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ('deny' in ran && ran.deny) return ran
    // The tool's own arguments sit beside the reserved keys on the event.
    const { tool: _tool, tool_use_id: _id, consent: _consent, ...args } = e as Record<string, unknown>
    const input = JSON.stringify(args)
    const output = ran.text ?? ''
    if (!ran.isError) {
      if (e.tool === 'Bash' && runsPrCreate(String(args.command ?? ''))) {
        // gh prints the new PR's URL; take the last one it printed, never the command's text.
        const pr = findPulls(output).at(-1)
        if (pr !== undefined) spot({ prs: [pr] })
      } else if (/create_pull_request|bind_pr/i.test(e.tool)) {
        spot({ prs: findPulls(`${input}\n${output}`).slice(-1) })
      }
    }
    if (/linear/i.test(e.tool)) spot({ issues: findIssues(input, teams) })
    return ran
  })

  // Reapply after session-note rewrites the title, and pick up the branch.
  on('command.run', async ($, e, next) => {
    const ran = await next(e)
    if (e.command === 'note' || e.command === 'note-color') await quietly(() => sync($))
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const found = spotted
      spotted = {}
      await quietly(async () => {
        const issues = await branchIssues($, teams)
        await offer($, merge({ prs: found.prs ?? [], issues: found.issues ?? [] }, { issues }))
      })
    }
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
      const tag = pr ? `#${pr[1]}` : (issue as string)
      const next = {
        ...merge(refs, pr ? { prs: [Number(pr[1])] } : { issues: [issue as string] }),
        declined: (refs.declined ?? []).filter(d => d !== tag),
      }
      await save($, next)
      return { text: `Tags: ${show(next)}; ${await sync($)}.` }
    }
    if (verb === 'remove' && (pr || issue)) {
      const next: Refs = {
        ...refs,
        prs: refs.prs.filter(n => !pr || n !== Number(pr[1])),
        issues: refs.issues.filter(i => !issue || i !== issue),
      }
      await save($, next)
      return { text: `Tags: ${show(next)}; ${await sync($)}.` }
    }
    return { text: 'Usage: /refs, /refs add MET-93, /refs add #123, /refs remove <tag>, /refs clear' }
  })
}
