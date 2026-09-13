import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runAcpInitialize,runAcpTurn} from '../scripts/lib/acp-client.mjs';
import {sha256Hex} from '../scripts/lib/mail-contract.mjs';
const defaults={model:{source:'provider-default',value:null},thinking:{source:'provider-default',value:null}};
const blocks=[{type:'text',text:'Synthetic lifecycle letter.'}];
function setup(t,scenario){
  const dir=mkdtempSync(join(tmpdir(),'acp-lifecycle-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const log=join(dir,'events.jsonl');const route={launch:{executable:process.execPath,arguments:[fileURLToPath(new URL('./fixtures/acp-fixture.mjs',import.meta.url)),'--scenario',scenario,'--identity','fixture-cedar','--event-log',log]},configuration:[]};
  return {dir,log,route,context:{workDir:dir,deadlineMs:1200,cancelGraceMs:300},events:()=>existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]};
}
test('T4 A04 incompatible protocol submits no prompt',async t=>{
  const f=setup(t,'version-mismatch');const r=await runAcpTurn(f.route,defaults,blocks,f.context);
  assert.equal(r.errorCode,'protocol-version-mismatch');assert.equal(r.promptsSubmitted,0);assert.equal(f.events().filter(e=>e.event==='prompt').length,0);
});
test('T4 initialize deadline is bounded, and raw auth labels are not returned',async t=>{
  const f=setup(t,'echo');const result=await runAcpInitialize(f.route,f.context);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret-account-marker'));
  const hang=setup(t,'no-response-init');await assert.rejects(runAcpInitialize(hang.route,hang.context),{code:'acp-deadline'});
});

test('a launchable non-ACP CLI is rejected before any discussion text is sent',async t=>{
  const f=setup(t,'echo');
  const entry=join(f.dir,'ordinary-cli.mjs'),wire=join(f.dir,'received.txt');
  writeFileSync(entry,`import fs from 'node:fs';process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(wire)},b));console.log('Ordinary interactive CLI; no ACP protocol');`);
  f.route.launch.arguments=[entry];
  const r=await runAcpTurn(f.route,defaults,blocks,f.context);
  assert.ok(r.errorCode);assert.equal(r.promptsSubmitted,0);assert.equal(r.stopReason,null);
  const sent=existsSync(wire)?readFileSync(wire,'utf8'):'';
  assert.ok(!sent.includes(blocks[0].text));assert.ok(!sent.includes('session/prompt'));
});

test('a missing endpoint never substitutes another CLI or submits a prompt',async t=>{
  const f=setup(t,'echo');f.route.launch.executable=join(f.dir,'not-installed.exe');
  const r=await runAcpTurn(f.route,defaults,blocks,f.context);
  assert.equal(r.errorCode,'endpoint-launch-failed');assert.equal(r.promptsSubmitted,0);
  assert.equal(r.stopReason,null);assert.deepEqual(f.events(),[]);
});
test('T4 A03 stopping reasons are preserved; empty normal reply has an error',async t=>{
  for(const [scenario,stop]of [['empty','end_turn'],['refuse','refusal'],['limit','max_tokens']]){
    const f=setup(t,scenario);const r=await runAcpTurn(f.route,defaults,blocks,f.context);assert.equal(r.stopReason,stop);
    assert.equal(r.errorCode,scenario==='empty'?'empty-reply':null);
  }
});
test('T4 A04 wrong session, malformed JSON and premature EOF never succeed',async t=>{
  for(const scenario of ['wrong-session','malformed','die-after-prompt']){
    const f=setup(t,scenario);const r=await runAcpTurn(f.route,defaults,blocks,f.context);
    assert.ok(r.errorCode);assert.equal(r.promptsSubmitted,1);assert.equal(f.events().filter(e=>e.event==='prompt').length,1);
    if(scenario==='wrong-session')assert.equal(r.replyText,'');
  }
});
test('T4 A05 default means no setters and observed remains unknown',async t=>{
  const f=setup(t,'echo');const r=await runAcpTurn(f.route,defaults,blocks,f.context);
  assert.deepEqual(r.observed,{model:null,thinking:null,source:'unknown'});
  assert.equal(f.events().filter(e=>e.method?.startsWith('session/set_')).length,0);
});
test('F1 explicit configuration requires a verified mapping even with a category',async t=>{
  for(const mapping of [[],[{intent:'model',api:'config-option',id:'model-choice'}]]){
    const f=setup(t,'config');f.route.configuration=mapping;
    const r=await runAcpTurn(f.route,{...defaults,model:{source:'user',value:'advanced'}},blocks,f.context);
    assert.equal(r.errorCode,'configuration-mapping-required');assert.equal(r.promptsSubmitted,0);
    assert.equal(f.events().filter(e=>e.method?.startsWith('session/set_')).length,0);
  }
});
test('Endpoint startup metadata is passed unchanged and cannot replace session protocol fields',async t=>{
  const f=setup(t,'echo');f.route.session_meta={fixture:{tools:[],settingSources:[],message:'synthetic $() 中文'}};f.route.launch.environment={REVIEW_MAIL_SYNTHETIC_MARKER:'scoped'};
  const r=await runAcpTurn(f.route,defaults,blocks,f.context);assert.equal(r.errorCode,null);
  assert.deepEqual(f.events().find(e=>e.event==='session-new-received').params._meta,f.route.session_meta);
  assert.equal(f.events().find(e=>e.event==='started').env_marker,'scoped');
});
test('F6 configuration drift while beforePrompt persists is rejected before sending',async t=>{
  const f=setup(t,'config-before-prompt');f.route.configuration=[{intent:'model',api:'config-option',id:'model-choice',evidence_ref:'synthetic-id-map'}];
  const r=await runAcpTurn(f.route,{...defaults,model:{source:'user',value:'advanced'}},blocks,{...f.context,beforePrompt:()=>new Promise(r=>setTimeout(r,150))});
  assert.equal(r.errorCode,'runtime-configuration-changed');assert.equal(r.promptsSubmitted,0);assert.equal(f.events().filter(e=>e.event==='prompt').length,0);
});
test('T4 A06 model change re-reads thinking options; mapping is required without categories',async t=>{
  const requested={model:{source:'user',value:'advanced'},thinking:{source:'user',value:'deep'}};
  for(const scenario of ['config','config-no-category']){
    const f=setup(t,scenario);
    f.route.configuration=[{intent:'model',api:'config-option',id:'model-choice',evidence_ref:'synthetic-id-map'},{intent:'thinking',api:'config-option',id:'thinking-choice',evidence_ref:'synthetic-id-map'}];
    const r=await runAcpTurn(f.route,requested,blocks,f.context);assert.equal(r.errorCode,null);assert.equal(r.observed.model,'advanced');assert.equal(r.observed.thinking,'deep');
    const setters=f.events().filter(e=>e.method==='session/set_config_option');assert.deepEqual(setters.map(e=>e.params.configId),['model-choice','thinking-choice']);
  }
  const f=setup(t,'config-no-category');const r=await runAcpTurn(f.route,requested,blocks,f.context);assert.equal(r.errorCode,'configuration-mapping-required');assert.equal(r.promptsSubmitted,0);
});
test('T4 A06 runtime settings changing under explicit request are not hidden',async t=>{
  const f=setup(t,'config-change');f.route.configuration=[{intent:'model',api:'config-option',id:'model-choice',evidence_ref:'synthetic-id-map'}];const r=await runAcpTurn(f.route,{model:{source:'user',value:'advanced'},thinking:defaults.thinking},blocks,f.context);
  assert.equal(r.errorCode,'runtime-configuration-changed');assert.equal(r.observed.model,'basic');
});
test('T4 A07 native load replay excluded; A08 missing sessions request reconstruction',async t=>{
  const f=setup(t,'replay-on-load');const r=await runAcpTurn(f.route,defaults,blocks,{...f.context,resumeRef:'synthetic-session'});
  assert.equal(r.errorCode,null);assert.equal(r.replyText,'Only the new reply.');assert.equal(r.nativeSessionRef,'synthetic-session');assert.equal(r.continuity,'native-resume');
  for(const scenario of ['echo','resume-missing']){const g=setup(t,scenario);const result=await runAcpTurn(g.route,defaults,blocks,{...g.context,resumeRef:'missing'});assert.equal(result.errorCode,'session-reconstruction-required');assert.equal(result.promptsSubmitted,0);}
});
test('T4 A09 permission allows only a hash-bound read; no implicit fs delegation',async t=>{
  const f=setup(t,'permission');const path=join(f.dir,'authorized.txt');writeFileSync(path,'synthetic snapshot');f.route.launch.arguments.push('--allowed-file',path);
  const r=await runAcpTurn(f.route,defaults,blocks,{...f.context,authorizedSnapshots:[{absolute_path:path,sha256:sha256Hex(readFileSync(path))}]});
  assert.equal(r.errorCode,null);assert.deepEqual(r.permissionDecisions.map(p=>p.decided),['allowed','denied','denied']);
  assert.ok(f.events().find(e=>e.event==='unsupported-fs').response.error);
});
test('T4 A10 ignored cancel is bounded with partial content and no confirmed stop',async t=>{
  const f=setup(t,'ignore-cancel');const r=await runAcpTurn(f.route,defaults,blocks,f.context);
  assert.equal(r.stopReason,null);assert.ok(r.errorCode);assert.equal(r.cancelRequested,true);assert.equal(r.promptsSubmitted,1);assert.equal(r.replyText,'Initial partial.');
  assert.equal(f.events().filter(e=>e.event==='prompt').length,1);
});

test('T4 mapped mode and legacy model require an actual confirmation',async t=>{
  for(const [scenario,intent,api,value]of [['mode','thinking','mode','deep'],['mode-no-ack','thinking','mode','deep'],['legacy-model','model','model','advanced']]){
    const f=setup(t,scenario);f.route.configuration=[{intent,api,id:'synthetic-map',evidence_ref:'synthetic-capability-contract'}];
    const r=await runAcpTurn(f.route,{...defaults,[intent]:{source:'user',value}},blocks,f.context);
    if(scenario==='mode-no-ack'){assert.equal(r.errorCode,'configuration-confirmation-missing');assert.equal(r.promptsSubmitted,0);}
    else{assert.equal(r.errorCode,null);assert.equal(r.observed[intent],value);}
  }
});

test('T4 resume excludes history but preserves config metadata and rejects foreign replay',async t=>{
  const f=setup(t,'config-load');f.route.configuration=[{intent:'model',api:'config-option',id:'model-choice',evidence_ref:'synthetic-id-map'}];const r=await runAcpTurn(f.route,{...defaults,model:{source:'user',value:'advanced'}},blocks,{...f.context,resumeRef:'existing'});
  assert.equal(r.errorCode,null);assert.equal(r.observed.model,'advanced');assert.equal(r.replyText,'Configured new reply.');
  const other=setup(t,'wrong-load-session');const bad=await runAcpTurn(other.route,defaults,blocks,{...other.context,resumeRef:'existing'});
  assert.equal(bad.errorCode,'session-correlation-mismatch');assert.equal(bad.promptsSubmitted,0);
});
