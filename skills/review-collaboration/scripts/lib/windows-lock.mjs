// Short, bounded Windows metadata transactions. No reviewer or shell command text.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { fail, sha256Hex, newUuid } from './mail-contract.mjs';
import { safePath, privateWritable } from './safe-files.mjs';

const source = fileURLToPath(new URL('./LockTransaction.cs', import.meta.url));
const builder = fileURLToPath(new URL('./build-lock-helper.ps1', import.meta.url));
const cache = fileURLToPath(new URL('../../_private/runtime/', import.meta.url));

// Runs a package builder script (build-lock-helper.ps1, build-argv-launcher.ps1).
// A timeout, a missing compiler and a rejected source need different fixes, so
// the result names which one happened instead of one catch-all failure; the
// builder reports its own cause as the last stderr line. The .NET Framework
// compiler writes temporary files beside its output and fails once that path
// nears 260 characters (sometimes CS1567, then always CS1619/CS2021), so the
// build runs in a short temporary folder and only the result is copied.
export const BUILD_TIMEOUT_MS = 20000;
export function runBuilder(builderFile, outputFile, timeoutMs = BUILD_TIMEOUT_MS) {
  const started = Date.now();
  const work = mkdtempSync(join(tmpdir(), 'rc-build-'));
  try {
    const built = join(work, basename(outputFile));
    const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', builderFile], {
      input: JSON.stringify({ output_file: built }), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
    });
    const result = classifyBuild(build, built, started);
    if (!result.ok) return result;
    try { copyFileSync(built, outputFile); } catch (e) { return { ok: false, reason: 'failed', detail: `copy ${e.code ?? 'error'}`, elapsed_ms: result.elapsed_ms }; }
    // Windows may refuse to start a freshly built, unsigned file (for example Smart App
    // Control). Start it once with empty input; a refused file is reported and not kept,
    // so it never becomes a cached helper that fails on every later call.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^REVIEW_LAUNCH_/i.test(k)));
    const probe = spawnSync(outputFile, [], { input: '', encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false, env });
    if (probe.error) {
      try { rmSync(outputFile, { force: true }); } catch {}
      return { ok: false, reason: 'launch-failed', detail: probe.error.code ?? 'error', elapsed_ms: Date.now() - started };
    }
    return result;
  } finally {
    // A compiler outliving a timed-out builder may still hold the folder; leaving it is harmless.
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

function classifyBuild(build, built, started) {
  const elapsed_ms = Date.now() - started;
  const detail = (build.stderr ?? '').trim().split(/\r?\n/).pop().trim().slice(0, 120);
  let reason = 'failed';
  if (build.error?.code === 'ETIMEDOUT') reason = 'timeout';
  else if (build.error) reason = 'failed';
  else if (build.status !== 0) reason = /^(compiler-unavailable|compile-failed)\b/.exec(detail)?.[1] ?? 'failed';
  else if (existsSync(built)) reason = null;
  return reason ? { ok: false, reason, detail: build.error?.code ?? (detail || `exit ${build.status}`), elapsed_ms } : { ok: true, elapsed_ms };
}

// Maps a failed build to a stable result code for the named helper.
export function failBuild(prefix, built, timeoutMs = BUILD_TIMEOUT_MS) {
  const failure = {
    timeout: [`${prefix}-build-timeout`, `the ${prefix} build did not finish within ${timeoutMs} ms`],
    'compiler-unavailable': [`${prefix}-compiler-unavailable`, 'the Windows .NET Framework C# compiler could not be started'],
    'compile-failed': [`${prefix}-compile-failed`, `the compiler rejected the ${prefix} source (${built.detail})`],
    failed: [`${prefix}-build-failed`, `the ${prefix} build failed (${built.detail})`],
    'launch-failed': [`${prefix}-launch-failed`, `Windows did not start the freshly built ${prefix} (${built.detail}); an application control policy such as Smart App Control may have blocked it, and the file was not kept`],
  }[built.reason];
  process.stderr.write(`${failure[0]}: ${built.detail} after ${built.elapsed_ms} ms\n`);
  fail(failure[0], failure[1]);
}

function helperExecutable() {
  const sourceHash=sha256Hex(Buffer.concat([readFileSync(source),readFileSync(builder)]));
  safePath(cache);
  // A hash prefix names the folder; the manifest keeps and checks the full hash.
  const dir=join(cache,sourceHash.slice(0,16)),exe=join(dir,'LockTransaction.exe');
  if(!existsSync(dir)){
    privateWritable(dirname(cache));mkdirSync(cache,{recursive:true});
    // Short folder names keep the helper's path well under 260 characters.
    const staging=join(cache,'build-'+newUuid().slice(0,8));mkdirSync(staging);
    const output=join(staging,'LockTransaction.exe');
    const built=runBuilder(builder,output);
    if(!built.ok){rmSync(staging,{recursive:true,force:true});failBuild('lock-helper',built);}
    writeFileSync(join(staging,'manifest.json'),JSON.stringify({source_sha256:sourceHash,executable_sha256:sha256Hex(readFileSync(output))}),{flag:'wx'});
    try{renameSync(staging,dir);}catch(e){if(!existsSync(dir))throw e;}
  }
  safePath(exe,{exists:true,file:true});safePath(join(dir,'manifest.json'),{exists:true,file:true});
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
  if(manifest.source_sha256!==sourceHash||manifest.executable_sha256!==sha256Hex(readFileSync(exe)))fail('lock-helper-cache-changed','compiled helper cache does not match its build record');
  return exe;
}

export function mutateLock(path, operation, data = {}, testOptions = {}) {
  const run = spawnSync(helperExecutable(), [], {
    input: JSON.stringify({ path, operation, ...data,
      test_hold_ms: testOptions.holdMs ?? 0, test_ready_file: testOptions.readyFile ?? null }),
    encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024, windowsHide: true, shell: false,
  });
  if (run.error || run.status !== 0) {
    const kind=/^lock-transaction-failed:([A-Za-z]+Exception)\s*$/.exec(run.stderr??'')?.[1];
    process.stderr.write(`lock-transaction-failed: ${kind ?? run.error?.code ?? run.status}\n`);
    fail('lock-transaction-failed', `Windows lock transaction failed: ${kind ?? run.error?.code ?? run.status}`);
  }
  let result;
  try { result = JSON.parse(run.stdout); } catch { fail('lock-transaction-invalid', 'Windows lock transaction returned no valid result'); }
  if (result?.schema_version !== 1 || !['created', 'occupied', 'deleted', 'changed', 'absent', 'unreadable'].includes(result.result)) {
    fail('lock-transaction-invalid', 'Windows lock transaction returned an unsupported result');
  }
  return result;
}
