// Strict host entry: business data is JSON; no command-string interpolation.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fields,safePath,readJSON,writeJSON,privateWritable} from './lib/safe-files.mjs';
import {fail,sha256Hex,assertUuid} from './lib/mail-contract.mjs';
import {runAcpAuthenticate} from './lib/acp-client.mjs';
import {normalizeIdentity,resolveSelection,readProfile,selectOnce,saveProfile} from './lib/reviewer-profile.mjs';
import {loadRoute,validateRoute,probeRoute,saveRoute,requireMaterialControl} from './lib/acp-route.mjs';
import {initProject,createTopic,openRun,appendNote,recoverRun,ensureRecordRootWritable} from './lib/mail-store.mjs';
import {sendExchange,finalizeExchange,statusExchange,cancelExchange,exchangePath,correlateReceipt,receiptProblems} from './lib/mail-exchange.mjs';

const helperPath=fileURLToPath(import.meta.url),packageRoot=dirname(dirname(helperPath)),privateRoot=join(packageRoot,'_private');
const contracts={
  authenticate:[['route_candidate_file','mode','authorization_ref'],['route_candidate_file','mode','authorization_ref']],
  resolve:[['host_id'],['host_id']],
  probe:[['route_candidate_file','mode','authorization_ref'],['route_candidate_file','mode','authorization_ref']],
  'profile-set':[['selection','expected_revision'],['selection','expected_revision']],
  'project-init':[['project_root'],['project_root']],
  'topic-create':[['title','related_topic_ids'],['title']],
  'run-open':[['topic_id','host_id','host_session_key','selection_override','timeout_ms'],['topic_id','host_id','host_session_key']],
  exchange:[['run_id','exchange_id','request_file','input_file'],['run_id','exchange_id','request_file','input_file']],
  status:[['run_id','exchange_id'],['run_id']],
  cancel:[['run_id','exchange_id'],['run_id','exchange_id']],
  recover:[['run_id','exchange_id'],['run_id','exchange_id']],
  note:[['run_id','kind','note_file','expected_topic_revision'],['run_id','kind','note_file','expected_topic_revision']],
};
function outsidePackage(path){
  safePath(path);const rel=relative(packageRoot,path);
  if(rel===''||(!rel.startsWith('..\\')&&rel!=='..'&&!isAbsolute(rel)))fail('record-root-overlaps-package','records cannot overwrite package source');
}
export function validateRequest(request){
  fields(request,['schema_version','action','record_root','args'],['schema_version','action','args']);
  if(request.schema_version!==1)fail('unsupported-request-version','expected schema 1');
  if(!Object.hasOwn(contracts,request.action))fail('unknown-action','unknown action');
  const [allowed,required]=contracts[request.action];fields(request.args,allowed,required,'args');
  if(!['resolve','probe','authenticate','profile-set','project-init'].includes(request.action)){
    safePath(request.record_root,{exists:true});outsidePackage(request.record_root);
  }else if(request.record_root!==undefined)fail('unexpected-record-root','this action does not use project records');
  return request;
}
function readInvocation(path,bytes){
  safePath(path,{exists:true,file:true});const invocation=readJSON(path);
  fields(invocation,['schema_version','invocation_id','envelope_sha256','request_file','transport_request','receipt_file','invocation_file','output_directory','timeout_source','run_sha256','effective_timeout_ms'],['schema_version','invocation_id','envelope_sha256','request_file','transport_request','receipt_file','invocation_file','output_directory']);
  if(invocation.schema_version!==1||invocation.invocation_file!==path||invocation.envelope_sha256!==sha256Hex(bytes))fail('invocation-mismatch','wrapper invocation does not match input');
  assertUuid(invocation.invocation_id,'invocation_id');
  for(const key of ['request_file','transport_request','receipt_file','invocation_file','output_directory'])safePath(invocation[key]);
  return invocation;
}
async function finalizeProbe(request,invocation){
  const receipt=correlateReceipt(invocation,helperPath);
  if(receiptProblems(receipt).length)fail('probe-transport-incomplete','cannot certify an unclean probe');
  const resultPath=join(invocation.output_directory,'probe-result.json'),result=readJSON(resultPath);
  const route=validateRoute(readJSON(request.args.route_candidate_file));
  if(result.route_fingerprint!==route.fingerprint||result.invocation_id!==invocation.invocation_id)fail('probe-correlation-mismatch','probe proof does not match route');
  const replyPath=join(invocation.output_directory,'probe-reply.md');
  if(result.level==='live-verified'&&(!existsSync(replyPath)||sha256Hex(readFileSync(replyPath))!==result.reply_sha256))fail('probe-reply-unverified','probe reply is missing or changed');
  if(!['initialized','live-verified'].includes(result.level)||result.prompts_submitted!==(result.level==='initialized'?0:1))fail('probe-contract-mismatch','probe did not perform the claimed work');
  const proofPath=join(invocation.output_directory,'probe-proof.json');
  writeJSON(proofPath,{schema_version:1,ok:true,level:result.level,route_fingerprint:route.fingerprint,receipt_sha256:sha256Hex(readFileSync(invocation.receipt_file)),reply_sha256:result.reply_sha256??null},{exclusive:true});
  route.verification={level:result.level,evidence_ref:proofPath};await saveRoute(privateRoot,route);
  return {route_id:route.route_id,level:result.level,observed:result.observed,prompts_submitted:result.prompts_submitted,evidence_refs:[proofPath]};
}
export async function dispatchRequest(request,invocation=null,{finalize=false}={}){
  validateRequest(request);const a=request.args;
  if(finalize){
    if(request.action==='exchange')return finalizeExchange(request,invocation,helperPath);
    if(request.action==='probe')return finalizeProbe(request,invocation);
    fail('finalize-action-invalid','only exchanges and probes have finalization');
  }
  switch(request.action){
    case 'authenticate':{
      if(!invocation)fail('wrapper-required','authentication requires bounded process ownership');
      if(!['inspect','login'].includes(a.mode))fail('authentication-mode-invalid','expected inspect or login');
      if(typeof a.authorization_ref!=='string'||!a.authorization_ref.trim()||a.authorization_ref.length>2048)fail('invalid-authorization','authentication needs a user authorization reference');
      const route=validateRoute(readJSON(a.route_candidate_file));
      privateWritable(privateRoot);
      const workDir=join(privateRoot,'work','auth-'+invocation.invocation_id);mkdirSync(workDir,{recursive:true});
      const submission=join(invocation.output_directory,'auth-submission.json'),outcome=join(invocation.output_directory,'auth-outcome.json');
      const identity={schema_version:1,invocation_id:invocation.invocation_id,route_fingerprint:route.fingerprint,mode:a.mode,method_id:a.mode==='login'?route.authentication?.method_id??null:null,prompts_submitted:0};
      writeJSON(submission,{...identity,status:'started',authorization_ref:a.authorization_ref},{exclusive:true});
      try{
        const deadlineMs=Math.max(100,Math.min(a.mode==='login'?300000:20000,(invocation.effective_timeout_ms??615000)-5000));
        const result=await runAcpAuthenticate(route,{workDir,mode:a.mode,deadlineMs});
        writeJSON(outcome,{...identity,status:result.status,error_code:null},{exclusive:true});
        return {...result,route_id:route.route_id,evidence_refs:[submission,outcome]};
      }catch(error){
        writeJSON(outcome,{...identity,status:'unconfirmed',error_code:error.code??'authentication-failed'},{exclusive:true});
        error.evidence_refs=[submission,outcome];throw error;
      }
    }
    case 'resolve':{
      const profile=await readProfile(privateRoot,a.host_id);
      if(!profile)fail('selection-required','choose one reviewer for this host');
      const route=loadRoute(privateRoot,profile.default_reviewer.route_id);
      return {selection:profile.default_reviewer,revision:profile.revision,route:{route_id:route.route_id,kind:route.kind,verification:route.verification.level,fingerprint:route.fingerprint}};
    }
    case 'profile-set':return {revision:await saveProfile(privateRoot,a.selection,a.expected_revision)};
    case 'project-init':{
      outsidePackage(a.project_root);return initProject(a.project_root);
    }
    case 'topic-create':return createTopic(request.record_root,a);
    case 'run-open':{
      const selection=await selectOnce(privateRoot,a.host_id,a.selection_override??null);
      if(!selection)fail('selection-required','choose one reviewer for this host');
      const route=loadRoute(privateRoot,selection.route_id);requireMaterialControl(route);
      if(route.verification.level!=='live-verified')fail('route-not-live-verified','complete initial probe first');
      const proof=readJSON(route.verification.evidence_ref);
      if(proof.ok!==true||proof.level!=='live-verified'||proof.route_fingerprint!==route.fingerprint)fail('route-verification-unproven','route proof does not match');
      const timeout=a.timeout_ms??600000;
      if(!Number.isInteger(timeout)||timeout<100||timeout>3600000)fail('invalid-deadline','timeout_ms is outside supported range');
      const run=await openRun(request.record_root,{topic_id:a.topic_id,host_id:normalizeIdentity(a.host_id,privateRoot),host_session_key:a.host_session_key,selection,route,timeouts:{prompt_deadline_ms:timeout,cancel_grace_ms:10000,outer_hard_timeout_ms:timeout+15000}});
      return {...run,selection,requested:{reviewer:selection.reviewer_tool_id,model:selection.model,thinking:selection.thinking,channel:'acp'}};
    }
    case 'exchange':return sendExchange(request,privateRoot,invocation);
    case 'status':return statusExchange(request.record_root,a.run_id,a.exchange_id??null);
    case 'cancel':return cancelExchange(request.record_root,a.run_id,a.exchange_id);
    case 'recover':{
      const locks=await recoverRun(request.record_root,a.run_id),dir=exchangePath(request.record_root,a.run_id,a.exchange_id);
      if(!existsSync(join(dir,'completion.json'))&&existsSync(join(dir,'dispatch.json'))&&(!locks.lock_present||locks.released)){
        const binding=readJSON(join(dir,'dispatch.json'));
        if(existsSync(binding.receipt_file)&&existsSync(binding.invocation_file)){
          const oldBytes=readFileSync(safePath(binding.request_file,{exists:true,file:true}));
          const old=readInvocation(binding.invocation_file,oldBytes);const original=JSON.parse(oldBytes.toString('utf8'));validateRequest(original);
          if(original.record_root!==request.record_root||original.args.run_id!==a.run_id||original.args.exchange_id!==a.exchange_id)fail('recovery-binding-mismatch','stored invocation does not refer to this exchange');
          await finalizeExchange(original,old,helperPath);
        }
      }
      return {...await statusExchange(request.record_root,a.run_id,a.exchange_id),lock_recovery:{released:locks.released,reason:locks.reason}};
    }
    case 'note':{
      safePath(a.note_file,{exists:true,file:true});return appendNote(request.record_root,a.run_id,a.kind,readFileSync(a.note_file),a.expected_topic_revision);
    }
    case 'probe':{
      if(!invocation)fail('wrapper-required','probe requires the bounded wrapper');
      const route=validateRoute(readJSON(a.route_candidate_file));
      const authorization=a.mode==='live'?{ref:a.authorization_ref,scope:'text-and-listed-snapshots',allowed_attachment_hashes:[]}:null;
      if(a.mode==='live'&&(typeof a.authorization_ref!=='string'||!a.authorization_ref))fail('authorization-required','live probe needs a synthetic-material authorization reference');
      privateWritable(privateRoot);
      const submission=join(invocation.output_directory,'probe-submission.json'),outcome=join(invocation.output_directory,'probe-outcome.json');
      const identity={schema_version:1,invocation_id:invocation.invocation_id,route_fingerprint:route.fingerprint};
      let result;
      try{result=await probeRoute(route,a.mode,authorization,{workDir:join(privateRoot,'work','probe-'+invocation.invocation_id),
        beforePrompt:()=>writeJSON(submission,{...identity,delivery:'unknown',stage:'prompt-submitting'},{exclusive:true}),
        onOutcome:r=>writeJSON(outcome,{...identity,...r},{exclusive:true})});}
      catch(error){error.evidence_refs=[...(error.evidence_refs??[]),...[submission,outcome].filter(existsSync)];throw error;}
      let replyHash=null;
      if(result.reply_text!==undefined){writeFileSync(join(invocation.output_directory,'probe-reply.md'),result.reply_text,{flag:'wx'});replyHash=sha256Hex(Buffer.from(result.reply_text));}
      writeJSON(join(invocation.output_directory,'probe-result.json'),{schema_version:1,invocation_id:invocation.invocation_id,route_fingerprint:route.fingerprint,level:result.level,prompts_submitted:result.prompts_submitted,observed:result.observed,reply_sha256:replyHash},{exclusive:true});
      return {stage:'awaiting-outer-receipt',route_id:route.route_id,prompts_submitted:result.prompts_submitted};
    }
  }
}
async function stdinBytes(){
  const chunks=[];let size=0;for await(const piece of process.stdin){size+=piece.length;if(size>4*1024*1024)fail('request-too-large','request envelope limit exceeded');chunks.push(piece);}return Buffer.concat(chunks);
}
async function main(){
  try{
    const bytes=await stdinBytes();let request;try{request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('malformed-request-json','request must be UTF-8 JSON');}
    const args=process.argv.slice(2);
    if(args.length!==2&&args.length!==3)fail('wrapper-required','expected wrapper invocation arguments');
    if(args[0]!=='--invocation'||(args.length===3&&args[2]!=='--finalize'))fail('invalid-helper-arguments','unexpected helper arguments');
    const invocation=readInvocation(args[1],bytes);
    const data=await dispatchRequest(request,invocation,{finalize:args[2]==='--finalize'});
    const ok=!['exchange','probe'].includes(request.action)||!['failed','unconfirmed'].includes(data.status)||data.stage==='awaiting-outer-receipt';
    const code=ok?'ok':data.status;
    process.stdout.write(JSON.stringify({ok,code,data,evidence_refs:data.evidence_refs??[]})+'\n');process.exitCode=ok?0:1;
  }catch(error){
    process.stdout.write(JSON.stringify({ok:false,code:error.code??'helper-failed',data:{},evidence_refs:error.evidence_refs??[]})+'\n');process.exitCode=1;
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await main();
