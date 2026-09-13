import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as acp from '../scripts/lib/acp-client.mjs';
import {fingerprintRoute,validateRoute} from '../scripts/lib/acp-route.mjs';
import {sha256Hex} from '../scripts/lib/mail-contract.mjs';
const defaults={model:{source:'provider-default',value:null},thinking:{source:'provider-default',value:null}};
const blocks=[{type:'text',text:'Synthetic auth test. 中文 🐉'}];
function fixture(scenario='auth-required',identity='new-agent-one',method='login-one'){
  const dir=mkdtempSync(join(tmpdir(),'review-auth-')),events=join(dir,'events.jsonl');
  const route={launch:{executable:process.execPath,arguments:[fileURLToPath(new URL('./fixtures/acp-fixture.mjs',import.meta.url)),'--scenario',scenario,'--identity',identity,'--auth-id',method,'--event-log',events]},authentication:{method_id:method}};
  return{route,context:{workDir:dir,deadlineMs:1200,cancelGraceMs:100},events:()=>existsSync(events)?readFileSync(events,'utf8').trim().split('\n').map(JSON.parse):[],dir};
}
const methods=f=>f.events().filter(e=>e.event==='request').map(e=>e.method);
test('configured authentication precedes session and prompt for two unfamiliar agents',async()=>{
  for(const [identity,id] of [['new-agent-one','login-one'],['new-agent-two','login-two']]){
    const f=fixture('auth-required',identity,id),r=await acp.runAcpTurn(f.route,defaults,blocks,f.context);
    assert.equal(r.errorCode,null);assert.equal(r.promptsSubmitted,1);
    assert.deepEqual(methods(f),['initialize','authenticate','session/new','session/prompt']);
    assert.deepEqual(f.events().find(e=>e.event==='authenticate-received').params,{methodId:id});
    assert.equal(f.events().find(e=>e.event==='prompt').received_text,blocks[0].text);
  }
});
test('inspect and login do not create sessions or submit prompts',async()=>{
  for(const mode of ['inspect','login']){
    const f=fixture();const r=await acp.runAcpAuthenticate(f.route,{...f.context,mode});
    assert.equal(r.promptsSubmitted,0);assert.equal(r.status,mode==='inspect'?'authentication-options':'authenticated');
    assert.deepEqual(methods(f),mode==='inspect'?['initialize']:['initialize','authenticate']);
    if(mode==='inspect')assert.deepEqual(r.authMethods,[{id:'login-one',name:'Synthetic login',type:'agent'}]);
  }
});
test('authentication selection is explicit, advertised, unique and supported',async()=>{
  for(const [scenario,method,expected]of [['auth-required',null,'reviewer-auth-required'],['auth-required','unknown','authentication-method-unavailable'],['auth-duplicate','login-one','authentication-method-unavailable'],['auth-terminal','login-one','authentication-terminal-required']]){
    const f=fixture(scenario);if(method===null)delete f.route.authentication;else f.route.authentication.method_id=method;
    const r=await acp.runAcpTurn(f.route,defaults,blocks,f.context);
    assert.equal(r.errorCode,expected);assert.equal(r.promptsSubmitted,0);assert.equal(methods(f).includes('authenticate'),false);
  }
});
test('authentication failure and timeout preserve zero prompts and hide raw diagnostics',async()=>{
  for(const scenario of ['auth-failure','auth-hang']){
    const f=fixture(scenario),r=await acp.runAcpTurn(f.route,defaults,blocks,f.context);
    assert.ok(r.errorCode);assert.equal(r.promptsSubmitted,0);
    assert.deepEqual(methods(f),['initialize','authenticate']);
    assert.ok(!JSON.stringify(r).includes('MUST-NOT-ESCAPE'));
  }
});
function completeRoute(f){
  const route={schema_version:1,route_id:randomUUID(),reviewer_tool_id:'new-agent-one',kind:'acp',...f.route,
    source:{url:'https://example.org/synthetic-auth',revision:'fixture',manifest_sha256:sha256Hex(readFileSync(f.route.launch.arguments[0]))},configuration:[],material_control:{status:'unverified',evidence_ref:null},verification:{level:'discovered',evidence_ref:null}};
  route.fingerprint=fingerprintRoute(route);return route;
}
test('authentication choice is fingerprinted, strict and backward compatible when absent',()=>{
  const f=fixture(),route=completeRoute(f);validateRoute(route);
  const changed=structuredClone(route);changed.authentication.method_id='other';assert.throws(()=>validateRoute(changed),e=>e.code==='revalidation-required');
  for(const authentication of [{method_id:'x',token:'synthetic-secret'},{method_id:''},{method_id:5}]){
    const invalid={...route,authentication};invalid.fingerprint=fingerprintRoute(invalid);assert.throws(()=>validateRoute(invalid));
  }
  const legacy={...route};delete legacy.authentication;legacy.fingerprint=fingerprintRoute(legacy);validateRoute(legacy);
  assert.notEqual(legacy.fingerprint,route.fingerprint);
  assert.equal(fingerprintRoute({...legacy,authentication:undefined}),legacy.fingerprint);
});
test('public wrapper exposes inspect and login with zero prompts and verified cleanup',()=>{
  for(const mode of ['inspect','login']){
    const f=fixture(),route=completeRoute(f),routeFile=join(f.dir,'route.json'),requestFile=join(f.dir,'request.json'),output=join(f.dir,'out');
    writeFileSync(routeFile,JSON.stringify(route));writeFileSync(requestFile,JSON.stringify({schema_version:1,action:'authenticate',args:{route_candidate_file:routeFile,mode,authorization_ref:'Synthetic authorized setup test'}}));
    const wrapper=fileURLToPath(new URL('../scripts/review-mail.ps1',import.meta.url));
    const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,'-RequestFile',requestFile,'-OutputDirectory',output,'-TimeoutMs','15000'],{windowsHide:true,shell:false,encoding:'utf8',timeout:25000});
    const result=JSON.parse(readFileSync(join(output,'mail-result.json'),'utf8'));
    assert.equal(run.status,0);assert.equal(result.ok,true);assert.equal(result.cleanup.owned_processes_remaining,0);
    assert.equal(result.data.promptsSubmitted,0);assert.equal(result.data.status,mode==='inspect'?'authentication-options':'authenticated');
    assert.deepEqual(methods(f),mode==='inspect'?['initialize']:['initialize','authenticate']);
    assert.equal(JSON.parse(readFileSync(join(output,'auth-outcome.json'),'utf8')).status,result.data.status);
    assert.equal(JSON.parse(readFileSync(routeFile,'utf8')).verification.level,'discovered');
  }
});
test('public wrapper rejects blank authorization before an endpoint is launched',()=>{
  const f=fixture(),routeFile=join(f.dir,'route.json'),requestFile=join(f.dir,'request.json'),output=join(f.dir,'out');
  writeFileSync(routeFile,JSON.stringify(completeRoute(f)));writeFileSync(requestFile,JSON.stringify({schema_version:1,action:'authenticate',args:{route_candidate_file:routeFile,mode:'login',authorization_ref:' '}}));
  const run=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../scripts/review-mail.ps1',import.meta.url)),'-RequestFile',requestFile,'-OutputDirectory',output,'-TimeoutMs','15000'],{windowsHide:true,shell:false,encoding:'utf8',timeout:25000});
  const result=JSON.parse(readFileSync(join(output,'mail-result.json'),'utf8'));
  assert.notEqual(run.status,0);assert.equal(result.code,'invalid-authorization');assert.equal(result.cleanup.owned_processes_remaining,0);assert.deepEqual(methods(f),[]);
});
