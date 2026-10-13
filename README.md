# title-refs

A Claude Code mod that tags a session's title with what it's working on, so
the desktop sidebar tells you at a glance:

```
Fix login redirect <MET-93> <#123>
```

## What gets tagged

- **A PR you open:** `gh pr create`, the GitHub tools' create-pull-request
  call, or the app's bind-PR call adds `<#123>`.
- **A Linear issue you're on:** the key in your git branch name
  (`you/met-93-fix-login`), in a Linear tool call, or in your prompt
  (`work on MET-93`) adds `<MET-93>`.

Look-alikes such as `UTF-8`, `ISO-9001` or `fix-12` are skipped. To tag only
your own teams, set **Linear team keys** (for example `MET,ENG`) in the
plugin's settings. Up to four tags show; the newest win.

## Install

Run these two commands in a terminal, then restart Claude Code:

```bash
claude plugin marketplace add avishalom/title-refs
claude plugin install title-refs@title-refs --scope user
```

## Commands

| Command | What it does |
| --- | --- |
| `/refs` | Show this session's tags |
| `/refs add MET-93` or `/refs add #123` | Add a tag by hand |
| `/refs remove MET-93` | Remove a wrong tag |
| `/refs clear` | Remove all tags |

## Notes

- Titles change only in the desktop app's Code tab; the terminal has no sidebar.
- If you named the session yourself, the app may ask before each rename.
- Works alongside session-note: tags stay at the end of the title after `/note`.
- Needs Claude Code 2.1.293 or later.
