const TYPES = 'feat|fix|refactor|perf|test|docs|build|ci|chore'

export function checkCommitMessage(raw: string): string | undefined {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter((line) => line.trim() !== '' && !line.startsWith('#'))
  if (kept.length === 0) return 'commit message is empty'
  if (kept.length > 1) return 'commit message must be a single line with no body'
  const subject = kept[0] ?? ''
  if (subject.startsWith('Merge ') || subject.startsWith('Revert ')) return undefined
  if (subject.length > 72) return `commit subject is ${subject.length} characters; the limit is 72`
  if (subject.endsWith('.')) return 'commit subject must not end with a period'
  const shape = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9][a-z0-9._/-]*\\))?: [a-z0-9]`, 'i')
  if (!shape.test(subject)) {
    return 'commit subject must be a Conventional Commit, like "fix: count a visit as one session"'
  }
  if (subject !== subject.toLowerCase()) return 'commit subject must be lowercase'
  return undefined
}

if (import.meta.main) {
  const path = Bun.argv[2]
  if (!path) {
    console.error('commit-msg: expected the path of the message file')
    process.exit(1)
  }
  const error = checkCommitMessage(await Bun.file(path).text())
  if (error) {
    console.error(error)
    process.exit(1)
  }
}
