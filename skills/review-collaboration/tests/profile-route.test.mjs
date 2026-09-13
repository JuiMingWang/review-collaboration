import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {sha256Hex} from '../scripts/lib/mail-contract.mjs';
import { normalizeIdentity, saveIdentity, saveProfile, readProfile, resolveSelection, selectOnce, importLegacy } from '../scripts/lib/reviewer-profile.mjs';
import { fingerprintRoute, validateRoute, saveRoute, loadRoute, selectRegistryEntry, fetchRegistryEntry, recordDiscoveryAttempt, probeRoute } from '../scripts/lib/acp-route.mjs';
import { initProject, createTopic, openRun, readRun } from '../scripts/lib/mail-store.mjs';

const fixture = fileURLToPath(new URL('./fixtures/acp-fixture.mjs', import.meta.url));
const def = {source:'provider-default',value:null};
function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'profile-route-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const priv=join(root,'_private');
  const route={schema_version:1,route_id:randomUUID(),reviewer_tool_id:'claude',kind:'acp',
    launch:{executable:process.execPath,arguments:[fixture,'--scenario','echo']},
    source:{url:'https://example.org/synthetic',revision:'fixture-1',manifest_sha256:'a'.repeat(64)},
    configuration:[],material_control:{status:'unverified',evidence_ref:null},verification:{level:'discovered',evidence_ref:null}};
  route.fingerprint=fingerprintRoute(route);
  const selection={host_id:'codex',reviewer_tool_id:'claude',route_id:route.route_id,model:def,thinking:def};
  return {root,priv,route,selection};
}

test('P01/P02 identities are tool identities; aliases cannot bypass self-review',async t=>{
  const f=setup(t);
  assert.equal(normalizeIdentity('Claude Code'),'claude');
  assert.equal(normalizeIdentity('codex.cmd'),'codex');
  for(const id of ['../escape','gpt-5.6-luna','unknown-agent']) assert.throws(()=>normalizeIdentity(id),{code:id==='unknown-agent'?'identity-evidence-required':'invalid-identity'});
  await saveRoute(f.priv,f.route);
  await assert.rejects(saveProfile(f.priv,{...f.selection,host_id:'Claude Code'},0),{code:'same-tool-review'});
  assert.equal(await resolveSelection(f.priv,'codex'),null);
});

test('Route startup controls are fingerprint-bound data, not credential or shell transport',t=>{
  const f=setup(t);f.route.launch.environment={SYNTHETIC_SETTING:'value',NODE_OPTIONS:null};f.route.session_meta={fixture:{tools:[],settingSources:[]}};
  f.route.fingerprint=fingerprintRoute(f.route);assert.equal(validateRoute(f.route).fingerprint,f.route.fingerprint);
  const changed=structuredClone(f.route);changed.session_meta.fixture.tools=['write'];assert.throws(()=>validateRoute(changed),{code:'revalidation-required'});
  for(const env of [{SYNTHETIC:'one',synthetic:'two'},{API_KEY:'synthetic-secret'},{BAD:5}]){const r=structuredClone(f.route);r.launch.environment=env;assert.throws(()=>fingerprintRoute(r),{code:'unsafe-launch'});}
});

test('P02 unknown tools need explicit canonical identity evidence, not model inference',async t=>{
  const f=setup(t);
  saveIdentity(f.priv,{schema_version:1,canonical_id:'fixture-orchid',aliases:['orchid-cli'],source_url:'https://example.org/orchid',source_revision:'fixed',evidence:'Synthetic tool identity, not a model.'});
  assert.equal(normalizeIdentity('orchid-cli',f.priv),'fixture-orchid');
  assert.throws(()=>saveIdentity(f.priv,{schema_version:1,canonical_id:'fixture-orchid',aliases:['codex'],source_url:'https://example.org',source_revision:'fixed',evidence:'bad'}),{code:'identity-alias-conflict'});
});

test('P03/P04 first selection, repeat read, temporary override, and host-local permanent change',async t=>{
  const f=setup(t); await saveRoute(f.priv,f.route);
  assert.equal(await resolveSelection(f.priv,'codex'),null);
  assert.equal(await saveProfile(f.priv,f.selection,0),1);
  assert.deepEqual(await resolveSelection(f.priv,'codex'),f.selection);
  const before=readFileSync(join(f.priv,'hosts','codex.json'));
  const other={...f.selection,thinking:{source:'user',value:'specific-option'}};
  assert.deepEqual(await selectOnce(f.priv,'codex',other),other);
  assert.deepEqual(readFileSync(join(f.priv,'hosts','codex.json')),before);
  await saveProfile(f.priv,other,1);
  assert.equal((await readProfile(f.priv,'codex')).revision,2);
  assert.equal(await resolveSelection(f.priv,'pi'),null);
  await assert.rejects(saveProfile(f.priv,f.selection,1),{code:'profile-revision-mismatch'});
});

test('P06 legacy imports remain candidates and do not alter their source',t=>{
  const f=setup(t); const p=join(f.root,'legacy.json');
  writeFileSync(p,JSON.stringify({schema_version:1,reviewer:'claude',channel:'cli',session_id:'fake'}));
  const before=readFileSync(p); const imported=importLegacy(p);
  assert.equal(imported.requires_acp_verification,true);
  assert.equal(imported.route,null);
  assert.equal(imported.native_session_ref,undefined);
  assert.deepEqual(readFileSync(p),before);
});

test('P05 two real writers CAS one host; active run keeps its frozen selection',async t=>{
  const f=setup(t);await saveRoute(f.priv,f.route);await saveProfile(f.priv,f.selection,0);
  const project=await initProject(f.root);const topic=await createTopic(project.record_root,{title:'Synthetic topic'});
  const run=await openRun(project.record_root,{topic_id:topic.topic_id,host_id:'codex',selection:f.selection,route:f.route,host_session_key:'synthetic-host'});
  const before=JSON.stringify(readRun(project.record_root,run.run_id));
  const go=join(f.root,'go');
  const children=[];
  for(let i=0;i<2;i++){
    const options={root:f.priv,selection:{...f.selection,model:{source:'user',value:'model-'+i}},expected:1,ready:join(f.root,'ready-'+i),go,result:join(f.root,'result-'+i+'.json')};
    const file=join(f.root,'writer-'+i+'.json');writeFileSync(file,JSON.stringify(options));
    const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/profile-writer.mjs',import.meta.url)),file],{shell:false,windowsHide:true,stdio:'ignore'});
    children.push({options,exited:new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);})});
  }
  const deadline=Date.now()+15000;
  while(children.some(c=>!existsSync(c.options.ready))){if(Date.now()>deadline)throw Error('writers-not-ready');await new Promise(r=>setTimeout(r,10));}
  writeFileSync(go,'go');assert.deepEqual((await Promise.all(children.map(c=>c.exited))).sort(),[0,1]);
  const results=children.map(c=>JSON.parse(readFileSync(c.options.result)));
  assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).code,'profile-revision-mismatch');
  assert.equal((await readProfile(f.priv,'codex')).revision,2);
  assert.equal(JSON.stringify(readRun(project.record_root,run.run_id)),before);
});

test('D01/D02 selected registry entry only, Windows availability and offline errors',async()=>{
  const index={version:'1.0.0',agents:[{id:'one',version:'1',distribution:{binary:{'windows-x86_64':{cmd:'./tool.exe',archive:'https://example.org/tool.zip'}}}},{id:'two',version:'2',distribution:{binary:{'linux-x86_64':{cmd:'./tool',archive:'https://example.org/linux.zip'}}}}]};
  assert.equal(selectRegistryEntry(index,'one').entry.id,'one');
  assert.equal(selectRegistryEntry(index,'one').entry.agents,undefined);
  assert.throws(()=>selectRegistryEntry(index,'absent'),{code:'registry-entry-missing'});
  assert.throws(()=>selectRegistryEntry(index,'two'),{code:'windows-distribution-missing'});
  await assert.rejects(fetchRegistryEntry('one',{fetchImpl:async()=>{throw new Error('offline');}}),{code:'registry-unavailable'});
});

test('D03/D04 entry is data; missing dependencies and shell interpreters rejected',t=>{
  const f=setup(t);
  assert.throws(()=>validateRoute({...f.route,launch:{executable:join(f.root,'missing.exe'),arguments:[]}}),{code:'dependency-missing'});
  assert.throws(()=>validateRoute({...f.route,launch:{executable:'C:\\Windows\\System32\\cmd.exe',arguments:['/c','echo unsafe']}}),{code:'unsafe-launch'});
  assert.throws(()=>validateRoute({...f.route,launch:{executable:process.execPath,arguments:['-e','anything']}}),{code:'unsafe-launch'});
  const bad={version:'1',agents:[{id:'bad',version:'1',distribution:{binary:{'windows-x86_64':{cmd:'../../outside.exe',archive:'https://example.org/a.zip'}}}}]};
  assert.throws(()=>selectRegistryEntry(bad,'bad'),{code:'unsafe-registry-entry'});
});

test('D05 saved route is local; changed entry bytes require revalidation',async t=>{
  const f=setup(t); const entry=join(f.root,'entry.mjs');writeFileSync(entry,'// version one');
  f.route.launch.arguments=[entry];f.route.fingerprint=fingerprintRoute(f.route);
  await saveRoute(f.priv,f.route);
  assert.equal(loadRoute(f.priv,f.route.route_id).fingerprint,f.route.fingerprint);
  writeFileSync(entry,'// version two');
  assert.throws(()=>loadRoute(f.priv,f.route.route_id),{code:'revalidation-required'});
});

test('D06 discovery permits one candidate and one reasoned correction',t=>{
  const f=setup(t);const id=randomUUID();
  assert.equal(recordDiscoveryAttempt(f.priv,id,'claude',{code:'dependency-missing'}),1);
  assert.equal(recordDiscoveryAttempt(f.priv,id,'claude',{code:'invalid-route',correction_evidence:'updated pinned entry path'}),2);
  assert.throws(()=>recordDiscoveryAttempt(f.priv,id,'claude',{code:'retry'}),{code:'discovery-budget-exhausted'});
});

test('S05 verification label alone cannot authorize endpoint startup',async t=>{
  const f=setup(t);f.route.material_control={status:'verified',evidence_ref:join(f.root,'missing.json')};
  await assert.rejects(probeRoute(f.route,'initialize',null),{code:'blocked-material-control'});
  await assert.rejects(probeRoute(f.route,'live',{ref:'synthetic',scope:'text-and-listed-snapshots',allowed_attachment_hashes:[]}),{code:'blocked-material-control'});
});

test('failed live probe preserves submission uncertainty and normalized outcome',async t=>{
  const f=setup(t);f.route.launch.arguments=[fixture,'--scenario','die-after-prompt'];f.route.fingerprint=fingerprintRoute(f.route);
  const proof=join(f.root,'material.json');writeFileSync(proof,JSON.stringify({schema_version:1,route_fingerprint:f.route.fingerprint,scope:'text-and-listed-snapshots',startup_control:'synthetic',tool_control:'synthetic',sources:['https://example.org/synthetic'],synthetic_only:true}));
  f.route.material_control={status:'verified',evidence_ref:proof,evidence_sha256:sha256Hex(readFileSync(proof))};
  const events=[];await assert.rejects(probeRoute(f.route,'live',{ref:'synthetic',scope:'text-and-listed-snapshots',allowed_attachment_hashes:[]},{workDir:f.root,deadlineMs:1500,cancelGraceMs:100,beforePrompt:()=>events.push('submitting'),onOutcome:r=>events.push(r)}));
  assert.equal(events[0],'submitting');assert.equal(events[1].prompts_submitted,1);assert.equal(events[1].delivery,'unknown');
  assert.ok(events[1].error_code);assert.equal(events[1].stop_reason,null);
  assert.equal(events[1].reply_text,undefined);assert.equal(events[1].native_session_ref,undefined);
});
