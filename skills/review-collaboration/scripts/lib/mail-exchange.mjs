import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,dirname,relative} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {assertUuid,fail,sha256Hex,fullTransportProblems,resultFromSaved,decodeUtf8Strict,jsonBytes} from './mail-contract.mjs';
import {safePath,readJSON,writeJSON,fields,privateWritable} from './safe-files.mjs';
import {normalizeIdentity} from './reviewer-profile.mjs';
import {validateRoute,requireMaterialControl} from './acp-route.mjs';
import {runAcpTurn} from './acp-client.mjs';
import {readRun,locateRun,readTopic,withRunLock,prepareExchange,readOutbound,readArchivedInput,readExchangeState,markDelivering,savePartialReply,saveReply,saveUnconfirmedResult,evaluateExchangeEvidence,commitCompletion,recoverExchange,recoverRun,ensureRecordRootWritable} from './mail-store.mjs';

export function exchangePath(root,runId,id){
  assertUuid(id,'exchange_id');const located=locateRun(root,runId);
  return safePath(join(located.run_dir,'exchanges',id));
}

export async function statusExchange(root,runId,id=null){
  const run=readRun(root,runId),topic=readTopic(root,run.topic_id);
  if(!id){
    const dir=join(locateRun(root,runId).run_dir,'exchanges');safePath(dir,{exists:true});
    const exchanges=[];for(const child of readdirSync(dir)){assertUuid(child,'exchange directory');exchanges.push(await statusExchange(root,runId,child));}
    return {run_id:runId,topic_id:run.topic_id,topic_revision:topic.revision,exchanges};
  }
  const dir=exchangePath(root,runId,id);const recovered=await recoverExchange(dir);
  let revision=null;try{revision=readArchivedInput(dir).expected_topic_revision;}catch{}
  return {run_id:runId,exchange_id:id,status:recovered.status,delivery:recovered.delivery,stage:recovered.stage,problems:recovered.problems,
    needs_reassessment:revision!==null&&revision!==topic.revision,expected_topic_revision:revision,current_topic_revision:topic.revision,
    completion_file:existsSync(join(dir,'completion.json'))?join(dir,'completion.json'):null,
    reply_file:existsSync(join(dir,'reply.md'))?join(dir,'reply.md'):null,evidence_refs:recovered.evidence_refs.map(p=>join(dir,p))};
}

export async function cancelExchange(root,runId,id){
  const dir=exchangePath(root,runId,id);const input=readArchivedInput(dir);
  if(existsSync(join(dir,'completion.json')))return {...await statusExchange(root,runId,id),cancel_requested:false,already_completed:true};
  ensureRecordRootWritable(root);const path=join(dir,'cancel.request.json');
  const marker={schema_version:1,run_id:runId,exchange_id:id,input_sha256:sha256Hex(readFileSync(join(dir,'input.json')))};
  try{writeJSON(path,marker,{exclusive:true});}catch(e){if(e.code!=='EEXIST')throw e;if(!isDeepStrictEqual(readJSON(path),marker))fail('cancel-marker-mismatch','cancel marker belongs to different input');}
  return {run_id:input.run_id,exchange_id:id,cancel_requested:true,status:'requested'};
}

function validateDraft(draft){
  fields(draft,['schema_version','project_id','topic_id','run_id','exchange_id','previous_exchange_id','expected_topic_revision','request_sha256','outbound_sha256','attachments','authorization','continuity'],['schema_version','project_id','topic_id','run_id','exchange_id','previous_exchange_id','expected_topic_revision','attachments','authorization'],'input');
  fields(draft.authorization,['ref','allowed_attachment_hashes','scope']);
  for(const item of draft.attachments??[])fields(item,['relative_path','sha256','source_revision','source_file'],['sha256','source_revision','source_file'],'attachment');
  if(draft.continuity!==undefined&&!['auto','letters-reconstructed'].includes(draft.continuity))fail('invalid-continuity','use auto or an explicit letters-reconstructed exchange');
}

function bindingFor(invocation,request){
  if(!invocation)fail('wrapper-required','exchange requires the bounded Windows wrapper');
  assertUuid(invocation.invocation_id,'invocation_id');
  return {schema_version:1,invocation_id:invocation.invocation_id,envelope_sha256:invocation.envelope_sha256,
    receipt_file:invocation.receipt_file,transport_request:invocation.transport_request,request_file:invocation.request_file,
    invocation_file:invocation.invocation_file,run_id:request.args.run_id,exchange_id:request.args.exchange_id};
}

export async function sendExchange(request,privateRoot,invocation){
  const root=request.record_root,{run_id:runId,exchange_id:id}=request.args;
  safePath(request.args.request_file,{exists:true,file:true});safePath(request.args.input_file,{exists:true,file:true});
  const bytes=readFileSync(request.args.request_file),draft=readJSON(request.args.input_file);validateDraft(draft);
  const dir=exchangePath(root,runId,id);
  // A duplicate is a local comparison even while the first caller is active.
  if(existsSync(dir)){
    await prepareExchange(root,runId,id,bytes,draft);
    return {...await statusExchange(root,runId,id),existing:true};
  }
  const binding=bindingFor(invocation,request);
  return withRunLock(root,runId,async()=>{
    const run=readRun(root,runId);
    if(invocation.timeout_source==='run-snapshot'){
      const runFile=join(locateRun(root,runId).run_dir,'run.json');
      if(invocation.run_sha256!==sha256Hex(readFileSync(runFile))||invocation.effective_timeout_ms!==run.timeouts.outer_hard_timeout_ms
        ||readJSON(invocation.transport_request).timeout_ms!==invocation.effective_timeout_ms)fail('run-deadline-changed','wrapper deadline no longer matches the frozen run');
    }
    if(normalizeIdentity(run.host_id,privateRoot)===normalizeIdentity(run.selection.reviewer_tool_id,privateRoot))fail('same-tool-review','frozen host and reviewer are the same tool');
    if(run.selection.host_id!==run.host_id||run.selection.route_id!==run.route.route_id||run.selection.reviewer_tool_id!==run.route.reviewer_tool_id)fail('run-selection-mismatch','frozen route and selection disagree');
    // A released helper lock is not proof its outer receipt was finalized.
    for(const previous of readdirSync(join(dirname(dir)))){
      const existing=exchangePath(root,runId,previous);
      if(!existsSync(join(existing,'completion.json')))fail('run-awaiting-finalization','finish/recover the earlier exchange before a new prompt');
      const evidence=await recoverExchange(existing);
      if(evidence.problems.length||evidence.delivery==='unknown')fail('run-unconfirmed','an earlier delivery is not safe to continue automatically');
    }
    const prepared=await prepareExchange(root,runId,id,bytes,draft);
    writeJSON(join(dir,'dispatch.json'),binding,{exclusive:true});
    let result;
    try{
      const route=validateRoute(run.route);requireMaterialControl(route);
      if(route.verification.level!=='live-verified')fail('route-not-live-verified','initialize alone does not establish a usable reviewer');
      // Windows process cwd has tighter length limits than record file paths.
      // Keep per-run execution cwd in the package's own private folder; letters
      // remain under the project record root and are sent as archived text.
      privateWritable(privateRoot);
      const workDir=join(privateRoot,'work',runId);safePath(workDir);mkdirSync(workDir,{recursive:true});
      let resumeRef=null,continuity=draft.continuity==='letters-reconstructed'?'letters-reconstructed':'new';
      if(draft.previous_exchange_id&&draft.continuity!=='letters-reconstructed'){
        const previous=exchangePath(root,runId,draft.previous_exchange_id);
        if(existsSync(previous)){
          const recovered=await recoverExchange(previous);
          if(recovered.problems.length||recovered.delivery==='unknown')fail('previous-exchange-unconfirmed','cannot auto-continue unknown delivery');
          resumeRef=recovered.completion?.native_session_ref??null;
          if(!resumeRef)fail('session-reconstruction-required','prepare authorized letter excerpts in a new exchange');
        }else fail('session-reconstruction-required','cross-run history must be explicitly reconstructed');
      }
      const controller=new AbortController(),cancelPath=join(dir,'cancel.request.json');
      const checkCancel=()=>{
        if(!existsSync(cancelPath))return;
        const marker=readJSON(cancelPath);
        if(marker.schema_version!==1||marker.run_id!==runId||marker.exchange_id!==id||marker.input_sha256!==prepared.inputHash)fail('cancel-marker-mismatch','cancel marker does not match this letter');
        controller.abort();
      };
      let cancelError=null;const poll=setInterval(()=>{try{checkCancel();}catch(e){cancelError=e;controller.abort();}},1000);
      const partialWrites=[];
      try{
        checkCancel();const input=readArchivedInput(dir);
        result=await runAcpTurn(route,run.selection,readOutbound(dir).content_blocks,{workDir,resumeRef,continuity,signal:controller.signal,
          deadlineMs:run.timeouts.prompt_deadline_ms,cancelGraceMs:run.timeouts.cancel_grace_ms,
          authorizedSnapshots:input.attachments.map(a=>({...a,absolute_path:safePath(join(dir,a.relative_path),{exists:true,file:true,within:dir})})),
          beforePrompt:async()=>{checkCancel();if(controller.signal.aborted)fail('cancelled-before-prompt','cancel requested before sending');await markDelivering(dir);},
          onUpdate:(_update,text)=>{const p=savePartialReply(dir,text);partialWrites.push(p);p.catch(()=>controller.abort());},
        });
        const saved=await Promise.allSettled(partialWrites);
        if(saved.some(s=>s.status==='rejected'))result.errorCode='partial-save-failed';
        if(cancelError)result.errorCode='cancel-marker-invalid';
      }finally{clearInterval(poll);}
    }catch(e){
      result={...(result??{replyText:'',stopReason:null,nativeSessionRef:null,continuity:'new',observed:{model:null,thinking:null,source:'unknown'},promptsSubmitted:readExchangeState(dir).delivery==='unknown'?1:0,reviewerProcess:{exitCode:null,closeReason:'unobserved'}}),errorCode:e.code??'exchange-failed'};
    }
    ensureRecordRootWritable(root);
    if(result.stopReason===null)await saveUnconfirmedResult(dir,result);else await saveReply(dir,result);
    writeJSON(join(dir,'turn-observations.json'),{schema_version:1,prompts_submitted:result.promptsSubmitted,cancel_requested:result.cancelRequested??false,permission_decisions:result.permissionDecisions??[]},{exclusive:true});
    return {run_id:runId,exchange_id:id,existing:false,status:'unconfirmed',stage:'awaiting-outer-receipt',exchange_dir:dir};
  });
}

export function receiptProblems(receipt){
  return fullTransportProblems(receipt);
}

export function correlateReceipt(invocation,helperPath){
  const receipt=readJSON(invocation.receipt_file);
  if(receipt.request_file!==invocation.transport_request||receipt.input_file!==invocation.request_file||receipt.input_sha256!==invocation.envelope_sha256
    ||receipt.resolved_executable?.toLowerCase()!==process.execPath.toLowerCase()
    ||!isDeepStrictEqual(receipt.resolved_arguments,[helperPath,'--invocation',invocation.invocation_file]))fail('transport-correlation-mismatch','receipt does not describe this invocation');
  if(sha256Hex(readFileSync(safePath(invocation.request_file,{exists:true,file:true})))!==invocation.envelope_sha256)fail('envelope-changed','request changed after dispatch');
  return receipt;
}

export async function finalizeExchange(request,invocation,helperPath){
  const root=request.record_root,{run_id:runId,exchange_id:id}=request.args,dir=exchangePath(root,runId,id);
  const receipt=correlateReceipt(invocation,helperPath);
  const binding=bindingFor(invocation,request);
  if(!existsSync(join(dir,'dispatch.json')))return statusExchange(root,runId,id);
  if(!isDeepStrictEqual(readJSON(join(dir,'dispatch.json')),binding)){
    // A later duplicate never replaces the first invocation's evidence.
    return {...await statusExchange(root,runId,id),existing:true};
  }
  ensureRecordRootWritable(root);await recoverRun(root,runId);
  return withRunLock(root,runId,async()=>{
    const evidence=evaluateExchangeEvidence(dir);
    const result=evidence.agentResult?resultFromSaved(evidence.agentResult,evidence.hashes.reply===null?'':readFileSync(join(dir,'reply.md'),'utf8')):
      {replyText:'',stopReason:null,nativeSessionRef:null,continuity:'new',observed:{model:null,thinking:null,source:'unknown'},errorCode:readExchangeState(dir).delivery==='not-sent'?'helper-failed-before-prompt':null,reviewerProcess:{exitCode:null,closeReason:'unobserved'}};
    const transport=join(dir,'transport');safePath(transport);mkdirSync(transport,{recursive:true});
    const receiptCopy=join(transport,'receipt.json');
    if(!existsSync(receiptCopy))writeJSON(receiptCopy,receipt,{exclusive:true});
    else if(!isDeepStrictEqual(readJSON(receiptCopy),receipt))fail('saved-receipt-mismatch','do not replace original process evidence');
    await commitCompletion(dir,result,receipt,{receiptProblems:receiptProblems(receipt)});
    return statusExchange(root,runId,id);
  });
}
