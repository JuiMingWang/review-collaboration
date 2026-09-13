import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareArgvLauncher} from '../scripts/lib/argv-launcher.mjs';

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
