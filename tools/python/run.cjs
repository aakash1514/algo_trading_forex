// Runs a Python app's venv interpreter on Windows and Linux alike, for the Nx targets of ml-service and
// research-agent (run from the app's directory, as their targets' cwd):
//
//   node ../../tools/python/run.cjs -m pytest            the venv's python with these arguments
//   node ../../tools/python/run.cjs --setup              create .venv (Python 3.12) and install the
//                                                        app's locks with hash checking: requirements.lock
//                                                        on Windows, requirements.linux.lock elsewhere,
//                                                        plus requirements-dev.lock
//
// The venv's python is .venv\Scripts\python.exe on Windows and .venv/bin/python elsewhere.
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

const windows = process.platform === 'win32';
const venvPython = path.resolve(windows ? '.venv/Scripts/python.exe' : '.venv/bin/python');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
if (args[0] === '--setup') {
  if (windows) run('py', ['-3.12', '-m', 'venv', '.venv']);
  else run('python3.12', ['-m', 'venv', '.venv']);
  const runtimeLock = windows ? 'requirements.lock' : 'requirements.linux.lock';
  // the Linux lock pins torch's CPU build (when the app uses torch), published on PyTorch's index
  const index = !windows ? ['--extra-index-url', 'https://download.pytorch.org/whl/cpu'] : [];
  run(venvPython, ['-m', 'pip', 'install', '--require-hashes', '--no-deps', ...index, '-r', runtimeLock, '-r', 'requirements-dev.lock']);
} else {
  if (!existsSync(venvPython)) {
    console.error(`No venv at ${path.dirname(path.dirname(venvPython))}: run npx nx setup <project> first`);
    process.exit(1);
  }
  run(venvPython, args);
}
