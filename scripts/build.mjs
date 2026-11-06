import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const backendSource = join(root, 'backend');
const backendOutput = join(dist, 'backend');
const [option] = process.argv.slice(2);
if (process.argv.length > 3 || option && option !== '--package' && option !== '--clean') {
  throw new Error('Usage: node scripts/build.mjs [--package | --clean]');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status})`);
}

rmSync(dist, { recursive: true, force: true });
if (option !== '--clean') {
  mkdirSync(backendOutput, { recursive: true });
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')]);
  const modules = readdirSync(backendSource).filter(name => name.endsWith('.rkt')).sort();
  for (const name of modules) copyFileSync(join(backendSource, name), join(backendOutput, name));
  run(process.env.RACO || 'raco', ['make', ...modules.map(name => join(backendOutput, name))]);
}

if (option === '--package') {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const releases = join(root, 'releases');
  const name = `racket-workbench-${version}.vsix`;
  const output = join(releases, name);
  mkdirSync(releases, { recursive: true });
  run(process.execPath, [join(root, 'node_modules/@vscode/vsce/vsce'), 'package',
    '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', output]);
  const checksum = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(`${output}.sha256`, `${checksum}  ${name}\n`);
}
