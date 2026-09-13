// End-to-end wrapper tests use an isolated package copy and synthetic ACP
// endpoint. Fixture route evidence is synthetic; no real route is certified.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cpSync,mkdirSync,readFileSync,writeFileSync,existsSync,rmSync,readdirSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {fingerprintRoute,saveRoute} from '../scripts/lib/acp-route.mjs';
import {saveProfile,readProfile,saveIdentity} from '../scripts/lib/reviewer-profile.mjs';
import {sha256Hex} from '../scripts/lib/mail-contract.mjs';
import {sendExchange,statusExchange,finalizeExchange} from '../scripts/lib/mail-exchange.mjs';

const original=dirname(dirname(fileURLToPath(import.meta.url)));
const root=join(original,'_private','t',randomUUID().slice(0,8));
const pkg=join(root,'p'),privateRoot=join(pkg,'_private');
const fixture=fileURLToPath(new URL('./fixtures/acp-fixture.mjs',import.meta.url));
const def={source:'provider-default',value:null};
before(()=>{mkdirSync(root,{recursive:true});mkdirSync(pkg);cpSync(join(original,'scripts'),join(pkg,'scripts'),{recursive:true});});
after(()=>{
  if(process.env.REVIEW_MAIL_TEST_EVIDENCE){
    const evidence=process.env.REVIEW_MAIL_TEST_EVIDENCE;mkdirSync(evidence,{recursive:true});
    for(const name of readdirSync(root))if(name!=='p')cpSync(join(root,name),join(evidence,name),{recursive:true});
  }
  rmSync(root,{recursive:true,force:true});
});
let number=0;
async function call(request,{timeout=30000,cwd=root,defaultOutput=false,outputDirectory=null}={}){
  const dir=join(root,'call-'+(++number));mkdirSync(dir);
  const requestFile=join(dir,'request.json'),output=join(dir,'out');writeFileSync(requestFile,JSON.stringify(request));
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(pkg,'scripts','review-mail.ps1'),'-RequestFile',requestFile,...(defaultOutput?[]:['-OutputDirectory',outputDirectory??output]),...(timeout===null?[]:['-TimeoutMs',String(timeout)])],{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b.toString());child.stderr.on('data',b=>stderr+=b.toString());
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const path=join(output,'mail-result.json');const result=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):JSON.parse(stdout.trim().split('\n').at(-1));
  return {exit,result,output:result.output_directory??outputDirectory??output,requestFile,stderr};
}
function data(r){return r.result.data??r.result.helper_result?.data;}
async function scenario(name,{ownFixture=false,extraArgs=[],deadline=15000}={}){
  const dir=join(root,'合成 project '+number+' '+randomUUID().slice(0,6));mkdirSync(dir);
  const entry=ownFixture?join(dir,'endpoint.mjs'):fixture;if(ownFixture)cpSync(fixture,entry);
  const events=join(dir,'events.jsonl');
  await saveIdentity(privateRoot,{schema_version:1,canonical_id:'fixture-cedar',aliases:['cedar-fixture'],source_url:'https://example.org/synthetic-endpoint',source_revision:'fixture',evidence:'Fictional test identity; no installed agent.'});
  const route={schema_version:1,route_id:randomUUID(),reviewer_tool_id:'fixture-cedar',kind:'acp',launch:{executable:process.execPath,arguments:[entry,'--scenario',name,'--identity','fixture-cedar','--event-log',events,...extraArgs]},source:{url:'https://example.org/synthetic-endpoint',revision:'fixture',manifest_sha256:sha256Hex(readFileSync(entry))},configuration:[],material_control:{status:'unverified',evidence_ref:null},verification:{level:'discovered',evidence_ref:null}};
  route.fingerprint=fingerprintRoute(route);
  const material=join(dir,'material.json');writeFileSync(material,JSON.stringify({schema_version:1,route_fingerprint:route.fingerprint,scope:'text-and-listed-snapshots',startup_control:'Synthetic fixture source read; no agent runtime.',tool_control:'Only fixture behavior; no model or auth.',sources:['https://example.org/synthetic-endpoint'],synthetic_only:true}));
  route.material_control={status:'verified',evidence_ref:material,evidence_sha256:sha256Hex(readFileSync(material))};
  // Local fixture evidence is deliberately not advertised as live agent proof.
  const proof=join(dir,'proof.json');writeFileSync(proof,JSON.stringify({ok:true,level:'live-verified',route_fingerprint:route.fingerprint,scope:'synthetic-test-input'}));
  route.verification={level:'live-verified',evidence_ref:proof};await saveRoute(privateRoot,route);
  const selection={host_id:'codex',reviewer_tool_id:'fixture-cedar',route_id:route.route_id,model:def,thinking:def};
  await saveProfile(privateRoot,selection,(await readProfile(privateRoot,'codex'))?.revision??0);
  const init=await call({schema_version:1,action:'project-init',args:{project_root:dir}});
  assert.equal(init.exit,0,JSON.stringify(init.result));const records=data(init).record_root;
  const topic=await call({schema_version:1,action:'topic-create',record_root:records,args:{title:'Synthetic premise',related_topic_ids:[]}});assert.equal(topic.exit,0,JSON.stringify(topic.result));
  const run=await call({schema_version:1,action:'run-open',record_root:records,args:{topic_id:data(topic).topic_id,host_id:'codex',host_session_key:'generated:synthetic-host',selection_override:null,timeout_ms:deadline}});assert.equal(run.exit,0,JSON.stringify(run.result));
  const id=randomUUID(),requestFile=join(dir,'letter.md'),inputFile=join(dir,'draft.json');writeFileSync(requestFile,'# Synthetic letter\n\n中文 🐉 and $() are data.');
  const draft={schema_version:1,project_id:data(init).project_id,topic_id:data(topic).topic_id,run_id:data(run).run_id,exchange_id:id,previous_exchange_id:null,expected_topic_revision:1,attachments:[],authorization:{ref:'synthetic-case',scope:'text-and-listed-snapshots',allowed_attachment_hashes:[]}};
  writeFileSync(inputFile,JSON.stringify(draft));
  const request={schema_version:1,action:'exchange',record_root:records,args:{run_id:draft.run_id,exchange_id:id,request_file:requestFile,input_file:inputFile}};
  return {dir,entry,events,records,route,selection,draft,request,requestFile,inputFile,exchangeDir:join(records,'topics',draft.topic_id,'runs',draft.run_id,'exchanges',id)};
}
const eventList=f=>existsSync(f.events)?readFileSync(f.events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];

test('F01 default output reaches selection and exchange finalize without scattering files',async()=>{
  const first=await call({schema_version:1,action:'resolve',args:{host_id:'codex'}},{defaultOutput:true});
  assert.equal(first.result.code,'selection-required',JSON.stringify(first.result));
  assert.equal(first.result.cleanup.cleanup_complete,true);
  assert.ok(first.output.startsWith(join(privateRoot,'operations')+'\\'));
  const f=await scenario('echo-input');
  const sent=await call(f.request,{defaultOutput:true,timeout:null,cwd:dirname(root)});
  assert.equal(sent.exit,0,JSON.stringify(sent.result));
  assert.ok(sent.output.startsWith(join(privateRoot,'operations')+'\\'));
  assert.equal(JSON.parse(readFileSync(join(sent.output,'finalize','receipt.json'))).cleanup.owned_processes_remaining,0);
  assert.equal(JSON.parse(readFileSync(join(f.exchangeDir,'completion.json'))).status,'reply-ready');
  const receiptHash=sha256Hex(readFileSync(join(sent.output,'receipt.json')));
  const again=await call(f.request,{outputDirectory:sent.output});
  assert.notEqual(again.exit,0);assert.equal(again.result.detail,'output-directory-exists');
  assert.equal(sha256Hex(readFileSync(join(sent.output,'receipt.json'))),receiptHash);
  assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  const ignore=join(privateRoot,'.gitignore'),saved=readFileSync(ignore);writeFileSync(ignore,'wrong-rule\n');
  try{assert.notEqual((await call({schema_version:1,action:'resolve',args:{host_id:'codex'}},{defaultOutput:true})).exit,0);}
  finally{writeFileSync(ignore,saved);}
});

test('F02 final reply with descendant-held pipes exits before deadline and cleans the tree',async()=>{
  const f=await scenario('reply-with-held-pipes');const r=await call(f.request,{timeout:10000});
  const receipt=JSON.parse(readFileSync(join(r.output,'receipt.json')));
  assert.equal(receipt.timed_out,false,JSON.stringify(r.result));assert.equal(r.exit,0,JSON.stringify(r.result));
  assert.equal(receipt.cleanup.cleanup_complete,true);assert.equal(receipt.cleanup.owned_processes_remaining,0);
  assert.equal(JSON.parse(readFileSync(join(f.exchangeDir,'completion.json'))).status,'reply-ready');
  const events=eventList(f);assert.equal(events.filter(e=>e.event==='prompt').length,1);
  const pids=events.flatMap(e=>[e.fixture_pid,e.child_pid]).filter(Number.isInteger);assert.equal(pids.length,2);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('F03 failed probe leaves correlated submission and outcome files without certifying route',async()=>{
  const f=await scenario('die-after-prompt'),candidate=join(f.dir,'probe-route.json');
  const route={...f.route,verification:{level:'discovered',evidence_ref:null}};writeFileSync(candidate,JSON.stringify(route));
  const r=await call({schema_version:1,action:'probe',args:{route_candidate_file:candidate,mode:'live',authorization_ref:'synthetic-case'}});
  assert.notEqual(r.exit,0);const submission=JSON.parse(readFileSync(join(r.output,'probe-submission.json'))),outcome=JSON.parse(readFileSync(join(r.output,'probe-outcome.json')));
  assert.equal(submission.delivery,'unknown');assert.equal(outcome.delivery,'unknown');assert.equal(outcome.prompts_submitted,1);
  assert.equal(submission.invocation_id,outcome.invocation_id);assert.equal(outcome.route_fingerprint,f.route.fingerprint);
  assert.equal(existsSync(join(r.output,'probe-proof.json')),false);assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
});

test('F2 exchange default outer deadline follows the frozen run; explicit cap is recorded',async()=>{
  for(const deadline of [3600000,15000]){
    const f=await scenario('echo',{deadline});const r=await call(f.request,{timeout:null});
    assert.equal(r.exit,0,JSON.stringify(r.result));
    assert.equal(JSON.parse(readFileSync(r.output+'.transport-request.json')).timeout_ms,deadline+15000);
    assert.equal(JSON.parse(readFileSync(r.output+'.invocation.json')).timeout_source,'run-snapshot');
    assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  }
  const f=await scenario('echo');const r=await call(f.request,{timeout:25000});assert.equal(r.exit,0);
  assert.equal(JSON.parse(readFileSync(r.output+'.transport-request.json')).timeout_ms,25000);
  assert.equal(JSON.parse(readFileSync(r.output+'.invocation.json')).timeout_source,'explicit-wrapper');
});

test('F7 partial write failure retains the ACP result and finished body when final storage works',async()=>{
  const f=await scenario('echo-input');const envelope=join(f.dir,'envelope.json');writeFileSync(envelope,JSON.stringify(f.request));
  const invocation={invocation_id:randomUUID(),envelope_sha256:sha256Hex(readFileSync(envelope)),request_file:envelope,transport_request:join(f.dir,'tr.json'),receipt_file:join(f.dir,'receipt.json'),invocation_file:join(f.dir,'inv.json')};
  const originalOpen=fs.openSync;let injected=false;
  fs.openSync=function(path,...args){if(!injected&&typeof path==='string'&&path.includes('reply.md.partial.')){injected=true;throw Object.assign(new Error('synthetic partial disk failure'),{code:'EIO'});}return originalOpen.call(this,path,...args);};syncBuiltinESMExports();
  try{await sendExchange(f.request,privateRoot,invocation);}finally{fs.openSync=originalOpen;syncBuiltinESMExports();}
  assert.equal(injected,true);
  const result=JSON.parse(readFileSync(join(f.exchangeDir,'agent-result.json')));
  assert.ok(result.stop_reason);assert.equal(result.error_code,'partial-save-failed');
  assert.equal(readFileSync(join(f.exchangeDir,'reply.md'),'utf8'),readFileSync(f.requestFile,'utf8'));
});

test('T5 M01 real wrapper finalizes one letter; duplicate and status cannot resend',async()=>{
  const f=await scenario('echo-input');const first=await call(f.request);assert.equal(first.exit,0,JSON.stringify(first.result));
  const completed=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(completed.status,'reply-ready');assert.equal(completed.semantic_acceptance,'pending');
  assert.equal(readFileSync(join(f.exchangeDir,'reply.md'),'utf8'),readFileSync(f.requestFile,'utf8'));
  const wire=eventList(f).find(e=>e.event==='prompt');assert.deepEqual(wire.received_blocks,JSON.parse(readFileSync(join(f.exchangeDir,'outbound.json'))).content_blocks);
  const hashes=['input.json','reply.md','completion.json'].map(n=>sha256Hex(readFileSync(join(f.exchangeDir,n))));
  const duplicate=await call(f.request);assert.equal(duplicate.exit,0,JSON.stringify(duplicate.result));
  const status=await call({schema_version:1,action:'status',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});assert.equal(status.exit,0);
  assert.deepEqual(['input.json','reply.md','completion.json'].map(n=>sha256Hex(readFileSync(join(f.exchangeDir,n)))),hashes);
  assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  assert.equal(eventList(f).filter(e=>e.event==='started').length,1);
  writeFileSync(f.requestFile,'changed');assert.notEqual((await call(f.request)).exit,0);assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  writeFileSync(join(f.exchangeDir,'reply.md'),'tampered response');
  const damaged=await call({schema_version:1,action:'status',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});
  assert.equal(data(damaged).status,'failed');assert.equal(data(damaged).stage,'completion-unverified');
});

test('T5 E02 crash after prompt remains unknown through duplicate and recovery',async()=>{
  const f=await scenario('die-after-prompt');const first=await call(f.request);assert.notEqual(first.exit,0);
  const completed=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(completed.status,'unconfirmed');assert.equal(completed.delivery,'unknown');assert.equal(existsSync(join(f.exchangeDir,'reply.md')),false);
  await call(f.request);await call({schema_version:1,action:'recover',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});
  assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  assert.equal(eventList(f).filter(e=>e.event==='started').length,1);
});

async function waitFor(check,limit=20000){const start=Date.now();while(!check()){if(Date.now()-start>limit)throw new Error('test-barrier-timeout');await new Promise(r=>setTimeout(r,50));}}

test('T5 E01 missing entry after run-open is not-sent and writes no fake reply',async t=>{
  const f=await scenario('echo',{ownFixture:true});renameSync(f.entry,f.entry+'.unavailable');
  t.after(()=>renameSync(f.entry+'.unavailable',f.entry));
  const r=await call(f.request);assert.notEqual(r.exit,0);
  const c=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(c.delivery,'not-sent');assert.equal(c.status,'failed');
  assert.equal(existsSync(join(f.exchangeDir,'reply.md')),false);assert.equal(eventList(f).length,0);
});

test('T5 C01 W02 a live run refuses a competing letter; cancellation keeps the late reply',async()=>{
  const f=await scenario('late-after-cancel',{deadline:45000});const active=call(f.request,{timeout:55000});
  await waitFor(()=>eventList(f).some(e=>e.event==='prompt'));
  const otherId=randomUUID(),otherInput=join(f.dir,'other-input.json');const otherDraft={...f.draft,exchange_id:otherId};writeFileSync(otherInput,JSON.stringify(otherDraft));
  const conflict=await call({...f.request,args:{...f.request.args,exchange_id:otherId,input_file:otherInput}});
  assert.notEqual(conflict.exit,0);assert.equal(conflict.result.code,'run-busy');
  assert.equal(existsSync(join(dirname(f.exchangeDir),otherId)),false);assert.deepEqual(JSON.parse(readFileSync(otherInput)),otherDraft);
  const cancelled=await call({schema_version:1,action:'cancel',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});assert.equal(cancelled.exit,0);
  const result=await active;assert.equal(result.exit,0,JSON.stringify(result.result));
  const completed=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(completed.status,'cancelled');assert.equal(completed.delivery,'replied');
  assert.match(readFileSync(join(f.exchangeDir,'reply.md'),'utf8'),/late chunk after cancel/);
  await call({schema_version:1,action:'recover',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});
  assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);assert.equal(eventList(f).filter(e=>e.event==='started').length,1);
});

test('T5 C02 different runs complete out of order without crossing letters',async()=>{
  const release=join(root,'release-first');
  const first=await scenario('hold-until-file',{extraArgs:['--release-file',release],deadline:45000});
  const second=await scenario('echo-input');
  const running=call(first.request,{timeout:55000});await waitFor(()=>eventList(first).some(e=>e.event==='prompt'));
  // E05 changes saved profile/route while the first run is in flight. Its
  // frozen route remains the original, and it must not switch to the second.
  const cachedRoute=join(privateRoot,'routes',first.route.route_id+'.json');const edited=JSON.parse(readFileSync(cachedRoute));edited.source.revision='changed-after-open';writeFileSync(cachedRoute,JSON.stringify(edited));
  const secondDone=await call(second.request);assert.equal(secondDone.exit,0,JSON.stringify(secondDone.result));
  assert.equal(existsSync(join(first.exchangeDir,'completion.json')),false);writeFileSync(release,'go');
  assert.equal((await running).exit,0);
  for(const f of [first,second]){const c=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(c.exchange_id,f.draft.exchange_id);assert.equal(c.run_id,f.draft.run_id);assert.equal(c.status,'reply-ready');assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);}
  assert.notEqual(readFileSync(join(first.exchangeDir,'reply.md'),'utf8'),readFileSync(join(second.exchangeDir,'reply.md'),'utf8'));
});

test('T5 S01 S08 continued letters submit only named snapshots; a new run uses explicit reconstruction',async()=>{
  const f=await scenario('echo-input');const source=join(f.dir,'approved.txt');writeFileSync(source,'Approved synthetic context only.');
  const hash=sha256Hex(readFileSync(source));f.draft.attachments=[{source_file:source,sha256:hash,source_revision:'revision-1'}];f.draft.authorization.allowed_attachment_hashes=[hash];writeFileSync(f.inputFile,JSON.stringify(f.draft));
  const first=await call(f.request);assert.equal(first.exit,0,JSON.stringify(first.result));
  writeFileSync(source,'Unapproved later edit.');
  const history=join(f.dir,'unrelated-history.md');writeFileSync(history,'DO-NOT-SEND-history-canary');
  const firstWire=eventList(f).find(e=>e.event==='prompt').received_text;assert.match(firstWire,/Approved synthetic context only/);assert.ok(!firstWire.includes('Unapproved later edit'));
  const once=await call(f.request);assert.equal(once.exit,0);assert.equal(eventList(f).filter(e=>e.event==='prompt').length,1);
  const next=await call({schema_version:1,action:'run-open',record_root:f.records,args:{topic_id:f.draft.topic_id,host_id:'codex',host_session_key:'generated:another-main-session'}});assert.equal(next.exit,0);
  const runId=data(next).run_id,exchangeId=randomUUID(),input=join(f.dir,'next.json'),letter=join(f.dir,'next.md');
  writeFileSync(letter,'Only this approved continuation excerpt.');writeFileSync(input,JSON.stringify({...f.draft,run_id:runId,exchange_id:exchangeId,previous_exchange_id:f.draft.exchange_id,continuity:'letters-reconstructed',attachments:[],authorization:{...f.draft.authorization,allowed_attachment_hashes:[]}}));
  const r=await call({schema_version:1,action:'exchange',record_root:f.records,args:{run_id:runId,exchange_id:exchangeId,input_file:input,request_file:letter}});assert.equal(r.exit,0,JSON.stringify(r.result));
  const last=eventList(f).filter(e=>e.event==='prompt').at(-1);assert.equal(last.received_text,readFileSync(letter,'utf8'));assert.ok(!last.received_text.includes('history-canary'));
  const completion=JSON.parse(readFileSync(join(f.records,'topics',f.draft.topic_id,'runs',runId,'exchanges',exchangeId,'completion.json')));assert.equal(completion.continuity,'letters-reconstructed');
});

test('T5 E06 W01 W02 hard deadline preserves partial and cleans its own real descendants',async()=>{
  const f=await scenario('hang-with-child',{deadline:45000});const r=await call(f.request,{timeout:12000});assert.notEqual(r.exit,0);
  const receipt=JSON.parse(readFileSync(join(r.output,'receipt.json')));assert.equal(receipt.timed_out,true);assert.equal(receipt.cleanup.cleanup_complete,true);assert.equal(receipt.cleanup.owned_processes_remaining,0);
  const c=JSON.parse(readFileSync(join(f.exchangeDir,'completion.json')));assert.equal(c.status,'unconfirmed');assert.equal(c.delivery,'unknown');assert.equal(existsSync(join(f.exchangeDir,'reply.md')),false);
  assert.match(readFileSync(join(f.exchangeDir,'reply.md.partial'),'utf8'),/Partial before hard timeout/);
  const events=eventList(f),pids=events.flatMap(e=>[e.fixture_pid,e.child_pid,e.grandchild_pid]).filter(Number.isInteger);assert.ok(pids.length>=3);
  for(const pid of pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});

test('T5 E03 E04 actual ACP reply waits for receipt; injected incomplete cleanup cannot pass',async()=>{
  const f=await scenario('echo-input');const envelope=join(f.dir,'envelope.json');writeFileSync(envelope,JSON.stringify(f.request));
  const helper=join(pkg,'scripts','review-mail.mjs');
  const invocation={invocation_id:randomUUID(),envelope_sha256:sha256Hex(readFileSync(envelope)),request_file:envelope,transport_request:join(f.dir,'synthetic-transport-request.json'),receipt_file:join(f.dir,'synthetic-receipt.json'),invocation_file:join(f.dir,'synthetic-invocation.json')};
  // Genuine ACP process, deliberately synthetic outer receipt for this boundary.
  await sendExchange(f.request,privateRoot,invocation);
  const waiting=await statusExchange(f.records,f.draft.run_id,f.draft.exchange_id);assert.equal(waiting.status,'unconfirmed');assert.equal(waiting.stage,'reply-saved-awaiting-completion');
  const receipt={schema_version:1,request_file:invocation.transport_request,input_file:envelope,input_sha256:invocation.envelope_sha256,resolved_executable:process.execPath,resolved_arguments:[helper,'--invocation',invocation.invocation_file],transport_status:'success',transport_exit_code:0,native_exit_code:0,process_started:true,timed_out:false,stdout_truncated:false,stderr_truncated:false,cleanup:{job_created:true,job_attached:true,process_exited:true,stdin_completed:true,stdout_completed:true,stderr_completed:true,stream_wait_timed_out:false,cleanup_complete:true,owned_processes_remaining:1,tree_terminated:true},capture:{launch_error:null,stdin_error:null,stdout_error:null,stderr_error:null}};
  writeFileSync(invocation.receipt_file,JSON.stringify(receipt));const finished=await finalizeExchange(f.request,invocation,helper);assert.equal(finished.status,'failed');assert.equal(finished.delivery,'replied');
  assert.equal(readFileSync(join(f.exchangeDir,'reply.md'),'utf8'),readFileSync(f.requestFile,'utf8'));
  // A later reader must still verify the saved process evidence, not trust a
  // user-edited successful summary over the owned-process count of one.
  const completionFile=join(f.exchangeDir,'completion.json'),completion=JSON.parse(readFileSync(completionFile));
  completion.status='reply-ready';completion.error_code=null;writeFileSync(completionFile,JSON.stringify(completion));
  assert.equal((await statusExchange(f.records,f.draft.run_id,f.draft.exchange_id)).status,'failed');
});

test('T5 C05 notes preserve history and only premise-change advances revision',async()=>{
  const f=await scenario('echo');await call(f.request);const note=join(f.dir,'note.md');writeFileSync(note,'Synthetic changed premise.');
  for(const kind of ['handoff','adoption','premise-change']){
    const r=await call({schema_version:1,action:'note',record_root:f.records,args:{run_id:f.draft.run_id,kind,note_file:note,expected_topic_revision:1}});assert.equal(r.exit,0,JSON.stringify(r.result));assert.equal(data(r).revision,kind==='premise-change'?2:1);
  }
  const status=await call({schema_version:1,action:'status',record_root:f.records,args:{run_id:f.draft.run_id,exchange_id:f.draft.exchange_id}});
  assert.equal(data(status).needs_reassessment,true);assert.equal(data(status).status,'reply-ready');
  assert.equal(readdirSync(join(f.records,'topics',f.draft.topic_id,'notes')).filter(n=>n.endsWith('.md')).length,3);
});

test('T5 dispatcher rejects unknown fields and nonlocal roots before reviewer startup',async()=>{
  const result=await call({schema_version:1,action:'project-init',args:{project_root:root,shell:'should never execute'}});assert.notEqual(result.exit,0);assert.equal(result.result.code,'unknown-field');
  const unsafe=await call({schema_version:1,action:'status',record_root:'\\\\synthetic-server\\records',args:{run_id:randomUUID()}});assert.notEqual(unsafe.exit,0);assert.equal(unsafe.result.code,'unsafe-path');
});
