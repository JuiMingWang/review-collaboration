// Short, bounded Windows metadata transactions. No reviewer or shell command text.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fail, sha256Hex, newUuid } from './mail-contract.mjs';
import { safePath, privateWritable } from './safe-files.mjs';

const source = fileURLToPath(new URL('./LockTransaction.cs', import.meta.url));
const builder = fileURLToPath(new URL('./build-lock-helper.ps1', import.meta.url));
const cache = fileURLToPath(new URL('../../_private/runtime/', import.meta.url));
function helperExecutable() {
  const sourceHash=sha256Hex(Buffer.concat([readFileSync(source),readFileSync(builder)]));
  safePath(cache);
  const dir=join(cache,sourceHash),exe=join(dir,'LockTransaction.exe');
  if(!existsSync(dir)){
    privateWritable(dirname(cache));mkdirSync(cache,{recursive:true});
    const staging=join(cache,sourceHash+'-'+newUuid());mkdirSync(staging);
    const output=join(staging,'LockTransaction.exe');
    const build=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',builder],{input:JSON.stringify({output_file:output}),encoding:'utf8',timeout:20000,maxBuffer:128*1024,windowsHide:true,shell:false});
    if(build.error||build.status!==0||!existsSync(output))fail('lock-helper-build-failed','Windows .NET Framework compiler unavailable');
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
    fail('lock-transaction-failed', `Windows lock transaction failed: ${kind ?? run.error?.code ?? run.status}`);
  }
  let result;
  try { result = JSON.parse(run.stdout); } catch { fail('lock-transaction-invalid', 'Windows lock transaction returned no valid result'); }
  if (result?.schema_version !== 1 || !['created', 'occupied', 'deleted', 'changed', 'absent', 'unreadable'].includes(result.result)) {
    fail('lock-transaction-invalid', 'Windows lock transaction returned an unsupported result');
  }
  return result;
}
