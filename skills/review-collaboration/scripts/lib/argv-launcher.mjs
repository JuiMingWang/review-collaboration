import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {safePath,privateWritable} from './safe-files.mjs';
import {fail,sha256Hex,newUuid} from './mail-contract.mjs';

const source=fileURLToPath(new URL('./ArgvLauncher.cs',import.meta.url));
const builder=fileURLToPath(new URL('./build-argv-launcher.ps1',import.meta.url));
const cache=fileURLToPath(new URL('../../_private/runtime/',import.meta.url));
export function prepareArgvLauncher(){
 const digest=sha256Hex(Buffer.concat([readFileSync(source),readFileSync(builder)]));
 const dir=join(cache,'argv-'+digest),exe=join(dir,'ArgvLauncher.exe');
 safePath(cache);
 if(!existsSync(dir)){
  privateWritable(dirname(cache));mkdirSync(cache,{recursive:true});
  const staging=join(cache,'argv-'+digest+'-'+newUuid());mkdirSync(staging);
  const output=join(staging,'ArgvLauncher.exe');
  const build=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',builder],{input:JSON.stringify({output_file:output}),encoding:'utf8',timeout:20000,maxBuffer:128*1024,shell:false,windowsHide:true});
  if(build.error||build.status!==0||!existsSync(output))fail('launcher-build-failed','Windows .NET Framework compiler unavailable');
  writeFileSync(join(staging,'manifest.json'),JSON.stringify({source_sha256:digest,executable_sha256:sha256Hex(readFileSync(output))}),{flag:'wx'});
  try{renameSync(staging,dir);}catch(error){if(!existsSync(dir))throw error;}
 }
 safePath(exe,{exists:true,file:true});const manifestPath=safePath(join(dir,'manifest.json'),{exists:true,file:true});
 const manifest=JSON.parse(readFileSync(manifestPath));
 if(manifest.source_sha256!==digest||manifest.executable_sha256!==sha256Hex(readFileSync(exe)))fail('launcher-cache-changed','compiled launcher no longer matches its build record');
 return exe;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify({ok:true,executable:prepareArgvLauncher()}));}catch(error){console.error(error.code??'launcher-build-failed');process.exitCode=1;}
}
