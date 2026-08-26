// util/run.js
import { execFile } from 'node:child_process'

export function run(cmd, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}
