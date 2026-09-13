import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { assertUuid, assertAuthorization, fail, sha256Hex, jsonBytes, newUuid } from './mail-contract.mjs';
import { fields, safePath, readJSON, writeJSON, privateWritable } from './safe-files.mjs';
import { acquireMetadataLock } from './mail-store.mjs';
import { runAcpInitialize, runAcpTurn } from './acp-client.mjs';

export const REGISTRY_URL='https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const HASH=/^[a-f0-9]{64}$/;
const HTTPS=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;}catch{return false;}};
const forbidden=/^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|bash|sh)\.exe$/i;

function launchFiles(route){
  fields(route.launch,['executable','arguments','environment'],['executable','arguments']);
  if(route.launch.environment!==undefined){
    const environment=route.launch.environment;
    if(!environment||typeof environment!=='object'||Array.isArray(environment)||Buffer.byteLength(JSON.stringify(environment))>65536)fail('unsafe-launch','environment must be a small settings object');
    const keys=new Set();for(const [key,value]of Object.entries(environment)){
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||keys.has(key.toUpperCase())||(value!==null&&typeof value!=='string')
        ||(value!==null&&(/TOKEN|PASSWORD|API_KEY|SECRET|AUTH/i.test(key)||value.includes('\0'))))fail('unsafe-launch','environment overrides are non-secret settings, with case-unique keys');
      keys.add(key.toUpperCase());
    }
  }
  const {executable,arguments:argv}=route.launch;
  if(typeof executable!=='string'||!executable.toLowerCase().endsWith('.exe')||forbidden.test(basename(executable)))fail('unsafe-launch','use a resolved native executable, never a shell');
  safePath(executable,{exists:true,file:true});
  if(!Array.isArray(argv)||argv.some(a=>typeof a!=='string'||a.includes('\0')))fail('unsafe-launch','arguments must be separate strings');
  const files=[executable];
  if(basename(executable).toLowerCase()==='node.exe'){
    if(!argv[0]||!isAbsolute(argv[0])||! /\.(mjs|cjs|js)$/i.test(argv[0]))fail('unsafe-launch','Node needs an absolute entry script; eval and runtime downloads are not supported');
    safePath(argv[0],{exists:true,file:true});files.push(argv[0]);
    // Include nearest package metadata, when present. Additional relevant
    // runtime files can be explicitly pinned; this is not a whole-disk hash.
    let dir=dirname(argv[0]);
    while(true){
      if(existsSync(join(dir,'package.json'))){for(const name of ['package.json','package-lock.json'])if(existsSync(join(dir,name)))files.push(join(dir,name));break;}
      const next=dirname(dir);if(next===dir)break;dir=next;
    }
  }
  if(route.runtime_files!==undefined){if(!Array.isArray(route.runtime_files))fail('invalid-route','runtime_files must be paths');for(const p of route.runtime_files){safePath(p,{exists:true,file:true});files.push(p);}}
  return [...new Set(files)].map(path=>({path:safePath(path,{exists:true,file:true}),sha256:sha256Hex(readFileSync(path))}));
}
export function fingerprintRoute(route){
  return sha256Hex(jsonBytes({launch:route.launch,source:route.source,configuration:route.configuration??[],...(route.session_meta!==undefined?{session_meta:route.session_meta}:{}),...(route.authentication!==undefined?{authentication:route.authentication}:{}),files:launchFiles(route)}));
}

export function validateRoute(candidate){
  fields(candidate,['schema_version','route_id','reviewer_tool_id','kind','launch','source','fingerprint','configuration','material_control','verification','runtime_files','session_meta','authentication'],['schema_version','route_id','reviewer_tool_id','kind','launch','source','fingerprint','configuration','material_control','verification'],'route');
  if(candidate.authentication!==undefined){
    fields(candidate.authentication,['method_id'],['method_id'],'authentication');
    const id=candidate.authentication.method_id;
    if(typeof id!=='string'||!id||id.length>256||/[\x00-\x1f]/.test(id))fail('invalid-route','authentication needs a non-secret advertised method_id');
  }
  if(candidate.session_meta!==undefined&&(!candidate.session_meta||typeof candidate.session_meta!=='object'||Array.isArray(candidate.session_meta)||Buffer.byteLength(JSON.stringify(candidate.session_meta))>65536))fail('invalid-route','session_meta must be a small ACP metadata object');
  if(candidate.schema_version!==1||candidate.kind!=='acp'||! /^[a-z][a-z0-9-]{0,63}$/.test(candidate.reviewer_tool_id))fail('invalid-route','schema, kind or tool identity invalid');
  assertUuid(candidate.route_id,'route_id');
  fields(candidate.source,['url','revision','manifest_sha256']);
  if(!HTTPS(candidate.source.url)||typeof candidate.source.revision!=='string'||!candidate.source.revision||!HASH.test(candidate.source.manifest_sha256))fail('invalid-route','source needs HTTPS, pinned revision and digest');
  if(!Array.isArray(candidate.configuration))fail('invalid-route','configuration must be an array');
  const intents=new Set();
  for(const m of candidate.configuration){
    fields(m,['intent','api','id','evidence_ref']);
    if(!['model','thinking'].includes(m.intent)||!['config-option','model','mode'].includes(m.api)||!m.id||!m.evidence_ref||intents.has(m.intent))fail('invalid-route','configuration mapping is missing, ambiguous or unsupported');intents.add(m.intent);
  }
  fields(candidate.material_control,['status','evidence_ref','evidence_sha256'],['status','evidence_ref']);
  if(!['unverified','verified'].includes(candidate.material_control.status))fail('invalid-route','material control status invalid');
  fields(candidate.verification,['level','evidence_ref']);
  if(!['discovered','initialized','live-verified'].includes(candidate.verification.level))fail('invalid-route','verification level invalid');
  const actual=fingerprintRoute(candidate);
  if(candidate.fingerprint!==actual)fail('revalidation-required','executable, entry, metadata, arguments or mapped configuration changed');
  return structuredClone(candidate);
}

export function requireMaterialControl(route){
  const m=route.material_control;
  if(m?.status!=='verified'||typeof m.evidence_ref!=='string'||!HASH.test(m.evidence_sha256??''))fail('blocked-material-control','startup and tool-read controls need fingerprint-bound evidence');
  let proof;
  try{safePath(m.evidence_ref,{exists:true,file:true});if(sha256Hex(readFileSync(m.evidence_ref))!==m.evidence_sha256)throw Error();proof=readJSON(m.evidence_ref);}catch{fail('blocked-material-control','material-control evidence is missing or changed');}
  if(proof.schema_version!==1||proof.route_fingerprint!==route.fingerprint||proof.scope!=='text-and-listed-snapshots'||!proof.startup_control||!proof.tool_control||!Array.isArray(proof.sources)||proof.sources.length===0||proof.sources.some(s=>!HTTPS(s)))fail('blocked-material-control','evidence must describe startup loading, tools and reviewed sources for this route');
  // This is a checked local assessment record, not proof of an OS sandbox.
  return proof;
}

export async function saveRoute(root,route){
  const value=validateRoute(route);privateWritable(root);mkdirSync(join(root,'routes'),{recursive:true});
  const lock=acquireMetadataLock(join(root,'routes',value.route_id+'.lock'),'route');
  try{
    if(value.verification.level!=='discovered'){
      requireMaterialControl(value);
      const proof=readJSON(value.verification.evidence_ref);
      if(proof.route_fingerprint!==value.fingerprint||proof.level!==value.verification.level||proof.ok!==true)fail('route-verification-unproven','probe evidence does not match route');
    }
    writeJSON(join(root,'routes',value.route_id+'.json'),value);
    writeFileSync(safePath(join(root,'routes',value.route_id+'.md'),{file:true}),`# ACP route\n\nTool: ${value.reviewer_tool_id}\nVersion: ${value.source.revision}\nSource: ${value.source.url}\nLevel: ${value.verification.level}\n\nRevalidate when fingerprint changes. Read the JSON for local launch details. No chat or authentication is stored here.\n`,'utf8');
  }finally{lock.release();}
  return value;
}
export function loadRoute(root,id){assertUuid(id,'route_id');const p=join(root,'routes',id+'.json');if(!existsSync(p))fail('route-missing','selected route has not been recorded');return validateRoute(readJSON(p));}

export function selectRegistryEntry(index,id,platform=process.arch==='arm64'?'windows-aarch64':'windows-x86_64'){
  if(!index||!Array.isArray(index.agents))fail('registry-format-invalid','expected versioned agents index');
  const matches=index.agents.filter(a=>a.id===id);
  if(matches.length!==1)fail(matches.length?'registry-entry-ambiguous':'registry-entry-missing','selected identity is not one registry entry');
  const entry=structuredClone(matches[0]);const dist=entry.distribution;
  if(!dist||(!dist.binary?.[platform]&&!dist.npx&&!dist.uvx))fail('windows-distribution-missing','no Windows binary or cross-platform package declaration');
  const binary=dist.binary?.[platform];
  if(binary){
    const cmd=binary.cmd;
    if(typeof cmd!=='string'||!/^(?:\.\/)?[a-zA-Z0-9_./-]+\.exe$/.test(cmd)||cmd.startsWith('/')||cmd.split('/').includes('..')||!HTTPS(binary.archive)||binary.args?.some(a=>typeof a!=='string'))fail('unsafe-registry-entry','binary description is not a safe relative entry');
  }
  for(const k of ['npx','uvx'])if(dist[k]&&(typeof dist[k].package!=='string'||/[\s;&|`$]/.test(dist[k].package)))fail('unsafe-registry-entry','package descriptor contains executable syntax');
  return {entry,platform,source_url:REGISTRY_URL,manifest_sha256:sha256Hex(jsonBytes(entry)),installation_required:true};
}

export async function fetchRegistryEntry(id,{fetchImpl=fetch,privateRoot=null}={}){
  let selected;
  try{
    const response=await fetchImpl(REGISTRY_URL,{signal:AbortSignal.timeout(10000),redirect:'error'});
    if(!response.ok)throw Error();
    let bytes=0;const chunks=[];
    for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>4*1024*1024)throw Error();chunks.push(Buffer.from(chunk));}
    selected=selectRegistryEntry(JSON.parse(Buffer.concat(chunks).toString('utf8')),id);
  }catch(e){if(e.code)throw e;fail('registry-unavailable','registry not available; an unchanged saved route needs no network');}
  if(privateRoot){privateWritable(privateRoot);mkdirSync(join(privateRoot,'registry'),{recursive:true});writeJSON(join(privateRoot,'registry',newUuid()+'.json'),selected);}
  return selected;
}

export function candidateFromRegistry(selected,localLaunch,reviewerToolId){
  const route={schema_version:1,route_id:newUuid(),reviewer_tool_id:reviewerToolId,kind:'acp',launch:localLaunch,source:{url:selected.source_url,revision:selected.entry.version,manifest_sha256:selected.manifest_sha256},configuration:[],material_control:{status:'unverified',evidence_ref:null},verification:{level:'discovered',evidence_ref:null}};
  route.fingerprint=fingerprintRoute(route);return validateRoute(route);
}

export function recordDiscoveryAttempt(root,id,reviewer,error){
  assertUuid(id,'discovery_id');privateWritable(root);mkdirSync(join(root,'discovery'),{recursive:true});
  const lock=acquireMetadataLock(join(root,'discovery',id+'.lock'),'discovery');
  try{
    const path=join(root,'discovery',id+'.json');const saved=existsSync(path)?readJSON(path):{schema_version:1,reviewer_tool_id:reviewer,attempts:[]};
    if(saved.reviewer_tool_id!==reviewer)fail('discovery-identity-mismatch','do not substitute a reviewer');
    if(saved.attempts.length>=2)fail('discovery-budget-exhausted','one candidate and one correction exhausted; separate diagnosis required');
    if(saved.attempts.length===1&&!error.correction_evidence)fail('correction-evidence-required','correction needs a concrete basis');
    saved.attempts.push({code:String(error.code),correction_evidence:error.correction_evidence??null});writeJSON(path,saved);return saved.attempts.length;
  }finally{lock.release();}
}

export async function probeRoute(route,mode,authorization,context={}){
  route=validateRoute(route);const proof=requireMaterialControl(route);
  if(!['initialize','live'].includes(mode))fail('invalid-probe-mode','expected initialize or live');
  if(mode==='live'){assertAuthorization(authorization);if(proof.synthetic_only!==true)fail('synthetic-probe-required','probe is limited to explicitly reviewed synthetic material');}
  const workDir=context.workDir??join(dirname(route.material_control.evidence_ref),'probe-'+newUuid());
  safePath(workDir);mkdirSync(workDir,{recursive:true});
  if(mode==='initialize'){
    const result=await runAcpInitialize(route,{workDir,deadlineMs:context.deadlineMs??10000});
    return {level:'initialized',capabilities:result.agentCapabilities??{},observed:{model:null,thinking:null,source:'unknown'},prompts_submitted:result.promptsSubmitted,evidence_refs:[]};
  }
  const defaults={model:{source:'provider-default',value:null},thinking:{source:'provider-default',value:null}};
  // Startup, native authentication and model discovery share this deadline.
  // A cold ACP process can spend over 30 seconds before submitting any prompt.
  const result=await runAcpTurn(route,defaults,[{type:'text',text:'Synthetic connectivity check. Reply with a short greeting. No file reads or changes.'}],{workDir,deadlineMs:context.deadlineMs??120000,...(context.cancelGraceMs?{cancelGraceMs:context.cancelGraceMs}:{}),beforePrompt:context.beforePrompt});
  context.onOutcome?.({prompts_submitted:result.promptsSubmitted,delivery:result.promptsSubmitted===0?'not-sent':result.stopReason?'replied':'unknown',
    error_code:result.errorCode,stop_reason:result.stopReason,observed:result.observed,reply_bytes:Buffer.byteLength(result.replyText,'utf8'),reviewer_process:result.reviewerProcess});
  if(result.errorCode||result.stopReason!=='end_turn'||!result.replyText.trim()||result.promptsSubmitted!==1)fail('live-probe-incomplete','no verified normal reply');
  return {level:'live-verified',capabilities:{},observed:result.observed,prompts_submitted:1,evidence_refs:[],reply_text:result.replyText};
}
