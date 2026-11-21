import { describe, expect, test } from 'bun:test'
import { checkCommitMessage } from '../scripts/commit-msg.js'

describe('commit message', () => {
  test('accepts one lowercase conventional line', () => {
    expect(checkCommitMessage('fix: count a visit from search as one session\n')).toBeUndefined()
    expect(checkCommitMessage('docs(readme): explain the visitor hash')).toBeUndefined()
    expect(checkCommitMessage('chore: set github repository and homepage')).toBeUndefined()
  })

  test('accepts a subject of exactly 72 characters', () => {
    const subject = `docs: ${'a'.repeat(66)}`
    expect(subject.length).toBe(72)
    expect(checkCommitMessage(subject)).toBeUndefined()
  })

  test('rejects a body, a period, a long subject, and the wrong shape', () => {
    expect(checkCommitMessage('fix: count a visit.\n')).toBe(
      'commit subject must not end with a period',
    )
    expect(checkCommitMessage('fix: count a visit\n\nMore detail.\n')).toBe(
      'commit message must be a single line with no body',
    )
    expect(checkCommitMessage(`docs: ${'a'.repeat(67)}`)).toMatch(/limit is 72/)
    expect(checkCommitMessage('Fix: count a visit')).toBe('commit subject must be lowercase')
    expect(checkCommitMessage('added a store')).toMatch(/Conventional Commit/)
    expect(checkCommitMessage('\n# just a comment\n')).toBe('commit message is empty')
  })

  test('lets git write merge and revert commits', () => {
    expect(checkCommitMessage("Merge branch 'main'\n")).toBeUndefined()
    expect(checkCommitMessage('Revert "fix: count a visit"\n')).toBeUndefined()
  })
})
