import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,statSync,copyFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareArgvLauncher} from '../scripts/lib/argv-launcher.mjs';
import {runBuilder,failBuild} from '../scripts/lib/windows-lock.mjs';

test('a failed helper build names its cause instead of one catch-all failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'review-build-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script=(name,body)=>{const f=join(root,name);writeFileSync(f,body);return f;};
 const slow=runBuilder(script('slow.ps1','Start-Sleep -Seconds 30'),join(root,'slow.exe'),1500);
 assert.equal(slow.reason,'timeout');assert.ok(slow.elapsed_ms<15000,'the build deadline must stop the builder');
 const lockBuilder=fileURLToPath(new URL('../scripts/lib/build-lock-helper.ps1',import.meta.url));
 // The real builder names a compiler rejection; an unwritable output folder is one.
 const direct=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',lockBuilder],{input:JSON.stringify({output_file:join(root,'missing-dir','LockTransaction.exe')}),encoding:'utf8',timeout:20000,windowsHide:true});
 assert.equal(direct.status,1);assert.match(direct.stderr.trim(),/^compile-failed:CS\d+$/);
 const rejected=runBuilder(script('reject.ps1',"[Console]::Error.WriteLine('compile-failed:CS1002');exit 1"),join(root,'reject.exe'));
 assert.deepEqual([rejected.reason,rejected.detail],['compile-failed','compile-failed:CS1002']);
 const noCompiler=runBuilder(script('none.ps1',"[Console]::Error.WriteLine('compiler-unavailable:FileNotFoundException');exit 1"),join(root,'none.exe'));
 assert.equal(noCompiler.reason,'compiler-unavailable');
 const silent=runBuilder(script('silent.ps1','exit 0'),join(root,'silent.exe'));
 assert.deepEqual([silent.reason,silent.detail],['failed','exit 0']);
 // Windows may refuse to start a freshly built file (for example Smart App Control).
 // A file that cannot start stands in for that: it is reported and never kept.
 const refused=runBuilder(script('refused.ps1',"$o=([Console]::In.ReadToEnd()|ConvertFrom-Json).output_file;[IO.File]::WriteAllText($o,'not a program')"),join(root,'refused.exe'));
 assert.equal(refused.reason,'launch-failed');assert.equal(existsSync(join(root,'refused.exe')),false);
 for(const [built,code] of [[slow,'lock-helper-build-timeout'],[rejected,'lock-helper-compile-failed'],[noCompiler,'lock-helper-compiler-unavailable'],[silent,'lock-helper-build-failed'],[refused,'lock-helper-launch-failed']])
  assert.throws(()=>failBuild('lock-helper',built),e=>e.code===code);
 assert.throws(()=>failBuild('launcher',slow),e=>e.code==='launcher-build-timeout');
});

test('helpers build and run when the skill folder has a long path',async t=>{
 // The .NET Framework compiler writes temporary files beside its output and fails
 // once that path nears 260 characters: at first only sometimes (CS1567), then always.
 const root=mkdtempSync(join(tmpdir(),'review-long-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let pkg=root;for(let i=0;pkg.length<140;i++)pkg=join(pkg,'long-install-path-'+i);
 const copy=(from,to)=>{if(statSync(from).isDirectory()){mkdirSync(to,{recursive:true});for(const n of readdirSync(from))copy(join(from,n),join(to,n));}else copyFileSync(from,to);};
 copy(fileURLToPath(new URL('../scripts',import.meta.url)),join(pkg,'scripts'));
 const {mutateLock}=await import(pathToFileURL(join(pkg,'scripts','lib','windows-lock.mjs')).href);
 const {prepareArgvLauncher:prepareLong}=await import(pathToFileURL(join(pkg,'scripts','lib','argv-launcher.mjs')).href);
 // Each call here is a fresh build. Where an application control policy (for example
 // Smart App Control) refuses a new unsigned file, the build itself still succeeded;
 // that refusal must be reported and the file not kept. A compile failure never passes.
 const runtime=join(pkg,'_private','runtime');
 const cached=()=>existsSync(runtime)?readdirSync(runtime).filter(n=>!n.startsWith('build-')):[];
 const outcome=(call,refused)=>{try{return call();}catch(e){assert.equal(e.code,refused,e.message);return 'refused';}};
 const before=cached().length;
 const lock=outcome(()=>mutateLock(join(root,'probe.lock'),'create',{owner:{pid:process.pid,start_time_ms:0,nonce:'long-path'}}).result,'lock-helper-launch-failed');
 assert.ok(lock==='created'||cached().length===before,'a refused helper is not cached');
 const launcher=outcome(prepareLong,'launcher-launch-failed');
 assert.ok(launcher==='refused'||launcher.startsWith(runtime));
});

test('native launcher preserves argv and duplex bytes, and propagates child failure',t=>{
 const root=mkdtempSync(join(tmpdir(),'review-launch-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const fixture=join(root,'echo.mjs');writeFileSync(fixture,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify(process.argv.slice(3)));process.stdin.pipe(process.stdout);process.exitCode=7;");
 const record=join(root,'argv.json'),exe=prepareArgvLauncher();
 const values=['','a b','中文😀','quote"here','trailing slash\\','\\"','$(untrusted);&`literal'];
 const body=Buffer.from('中文😀\r\n\n keep trailing  \n');
 const run=spawnSync(exe,values,{input:body,timeout:10000,windowsHide:true,shell:false,env:{...process.env,REVIEW_LAUNCH_TARGET:process.execPath,REVIEW_LAUNCH_ARGV:JSON.stringify([fixture,record])}});
 assert.ifError(run.error);assert.equal(run.status,7,run.stderr.toString());assert.deepEqual(run.stdout,body);assert.deepEqual(JSON.parse(readFileSync(record)),values);
 const missing=spawnSync(exe,[],{timeout:5000,windowsHide:true,env:{...process.env,REVIEW_LAUNCH_TARGET:join(root,'missing.exe'),REVIEW_LAUNCH_ARGV:'[]'}});
 assert.equal(missing.status,127);
 for(const bad of ['{}','[null]','[7]']){const r=spawnSync(exe,[],{timeout:5000,windowsHide:true,env:{...process.env,REVIEW_LAUNCH_TARGET:process.execPath,REVIEW_LAUNCH_ARGV:bad}});assert.equal(r.status,2);}
});

test('outer Job timeout cleans native launcher and its real descendant tree',t=>{
 const root=mkdtempSync(join(tmpdir(),'review-launch-job-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const fixture=join(root,'tree.mjs'),pids=join(root,'pids.json'),input=join(root,'stdin.txt'),request=join(root,'request.json'),out=join(root,'out');
 writeFileSync(fixture,"import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';if(process.argv[2]!=='leaf'){const c=spawn(process.execPath,[process.argv[1],'leaf'],{stdio:'ignore',windowsHide:true,shell:false});writeFileSync(process.argv[2],JSON.stringify([process.pid,c.pid]));}setInterval(()=>{},1000);");writeFileSync(input,'');
 writeFileSync(request,JSON.stringify({version:1,executable:prepareArgvLauncher(),arguments:[fixture,pids],working_directory:root,stdin_file:input,timeout_ms:2000}));
 const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/invoke-process.ps1',import.meta.url)),'-RequestFile',request,'-OutputDirectory',out],{encoding:'utf8',timeout:20000,windowsHide:true,shell:false,env:{...process.env,REVIEW_LAUNCH_TARGET:process.execPath,REVIEW_LAUNCH_ARGV:'[]'}});
 assert.ifError(run.error);assert.equal(run.status,124,run.stderr);
 const receipt=JSON.parse(readFileSync(join(out,'receipt.json')));assert.equal(receipt.timed_out,true);assert.equal(receipt.cleanup.cleanup_complete,true);assert.equal(receipt.cleanup.owned_processes_remaining,0);
 for(const pid of JSON.parse(readFileSync(pids)))assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('native launcher sends each turn and reply before stdin EOF',async t=>{
 const root=mkdtempSync(join(tmpdir(),'review-launch-turns-'));
 const fixture=join(root,'turns.mjs');
 writeFileSync(fixture,"import{createInterface}from'node:readline';process.stdout.write('ready\\n');createInterface({input:process.stdin}).on('line',s=>process.stdout.write(s+'\\n'));");
 const child=spawn(prepareArgvLauncher(),[],{windowsHide:true,shell:false,stdio:'pipe',env:{...process.env,REVIEW_LAUNCH_TARGET:process.execPath,REVIEW_LAUNCH_ARGV:JSON.stringify([fixture])}});
 const closed=once(child,'close');let body='';child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{body+=s;});child.stderr.resume();child.stdin.on('error',()=>{});
 t.after(async()=>{child.stdin.end();const timer=setTimeout(()=>child.kill(),4000);try{await closed;}finally{clearTimeout(timer);rmSync(root,{recursive:true,force:true});}});
 async function waitFor(expected){const until=Date.now()+3000;while(body!==expected&&Date.now()<until)await new Promise(r=>setTimeout(r,20));assert.equal(body,expected,'a persistent peer must receive bytes without closing the session');}
 await waitFor('ready\n');
 for(const line of ['first 中文😀','second "literal"']){const expected=body+line+'\n';child.stdin.write(line+'\n');await waitFor(expected);assert.equal(child.stdin.writableEnded,false);}
});
