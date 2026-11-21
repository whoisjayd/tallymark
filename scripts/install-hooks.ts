const inside = Bun.spawnSync(['git', 'rev-parse', '--is-inside-work-tree'], {
  stdout: 'ignore',
  stderr: 'ignore',
})
if (inside.exitCode !== 0) process.exit(0)

const installed = Bun.spawnSync(['bunx', 'lefthook', 'install'], {
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(installed.exitCode ?? 1)
