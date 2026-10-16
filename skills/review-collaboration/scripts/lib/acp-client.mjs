// The sole SDK boundary. Routing never branches on reviewer tool identity.
import {spawn} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {readFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {client,ndJsonStream,PROTOCOL_VERSION} from '@agentclientprotocol/sdk';
import {safePath} from './safe-files.mjs';
import {sha256Hex} from './mail-contract.mjs';

// A read-access route always starts through this launcher, so its whole
// process tree runs at Low integrity: Windows refuses every write outside
// folders labelled low. Exit 125 means the low-integrity start itself failed.
const LOW_LAUNCHER=join(dirname(dirname(fileURLToPath(import.meta.url))),'low-integrity-launch.ps1');
const LOW_LAUNCH_FAILED=125;
function lowIntegrityCommand(executable,argv){
  const powershell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return [powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',LOW_LAUNCHER,'-ArgvBase64',Buffer.from(JSON.stringify([executable,...argv]),'utf8').toString('base64')]];
}
function within(root,path){
  const r=resolve(root).toLowerCase(),p=resolve(path).toLowerCase();
  return p===r||p.startsWith(r.endsWith(sep)?r:r+sep);
}
// Capability check before a run chooses direct reading: a Low-integrity child
// must start and must be refused a write into an ordinary (medium) folder.
export async function lowIntegrityPreflight(probeDir,{timeoutMs=20000}={}){
  const target=join(probeDir,'low-integrity-preflight.txt');
  const script=`try{require('fs').writeFileSync(${JSON.stringify(target)},'x');process.exit(3)}catch(e){process.exit(e.code==='EPERM'||e.code==='EACCES'?0:4)}`;
  const [command,args]=lowIntegrityCommand(process.execPath,['-e',script]);
  const exit=await new Promise(done=>{
    const child=spawn(command,args,{shell:false,windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();done(null);},timeoutMs);
    child.once('error',()=>{clearTimeout(timer);done(null);});
    child.once('close',code=>{clearTimeout(timer);done(code);});
  });
  if(exit===3)try{unlinkSync(target);}catch{}
  if(exit===0)return {ok:true,code:null};
  return {ok:false,code:exit===LOW_LAUNCH_FAILED?'low-integrity-launch-failed':exit===3?'low-integrity-not-enforced':'low-integrity-preflight-failed'};
}

export class AcpError extends Error {
  constructor(code,message=code,evidenceRefs=[]){super(message);this.name='AcpError';this.code=code;this.evidence_refs=evidenceRefs;}
}
const CAPABILITIES={fs:{readTextFile:false,writeTextFile:false},terminal:false};
const unknown=()=>({model:null,thinking:null,source:'unknown'});
function duration(value,fallback,max=3600000){if(value===undefined)return fallback;if(!Number.isInteger(value)||value<1||value>max)throw new AcpError('invalid-deadline');return value;}
function faultChannel(){let reject;const promise=new Promise((_,r)=>{reject=r;});promise.catch(()=>{});return {promise,fail:code=>reject(new AcpError(code))};}
const sleep=ms=>new Promise(r=>{const timer=setTimeout(r,ms);timer.unref();});

async function withEndpoint(route,context,operation,configure){
  const {executable,arguments:argv}=route.launch??{};
  if(typeof executable!=='string'||!Array.isArray(argv)||argv.some(a=>typeof a!=='string'))throw new AcpError('route-invalid');
  // Validate before spawning; a rejected deadline must not leave an open child.
  const hardMs=duration(context.hardDeadlineMs,duration(context.deadlineMs,600000)+duration(context.cancelGraceMs,10000),3615000);
  const environment={...process.env};
  for(const [name,value]of Object.entries(route.launch.environment??{})){
    for(const key of Object.keys(environment))if(key.toUpperCase()===name.toUpperCase())delete environment[key];
    if(value!==null)environment[name]=value;
  }
  const [command,commandArgs]=route.read_access?lowIntegrityCommand(executable,argv):[executable,argv];
  const child=spawn(command,commandArgs,{cwd:context.workDir,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let exitCode=null,closed=false;const fault=faultChannel();
  const close=new Promise(resolve=>child.once('close',code=>{exitCode=code;closed=true;resolve();}));
  child.once('error',()=>fault.fail('endpoint-launch-failed'));
  child.stdin.on('error',()=>{});
  child.stdout.on('error',()=>fault.fail('endpoint-stdout-failed'));
  child.stderr.on('error',()=>fault.fail('endpoint-stderr-failed'));
  // Drain diagnostics without copying account labels, raw events or stderr
  // into the normal result. No authentication detail is returned.
  child.stderr.resume();
  const app=client({name:'review-collaboration-acp'});if(configure)configure(app,fault);
  const timer=setTimeout(()=>fault.fail('acp-deadline'),hardMs);
  let value,error=null,closeReason='unobserved',connection,operationSettled=false;
  try{
    // connectWith cancels the stdout reader when the operation returns. Keep it
    // open until the endpoint has handled stdin EOF and flushed its final output.
    connection=app.connect(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
    const result=Promise.resolve().then(()=>operation(connection.agent,fault)).finally(()=>{operationSettled=true;});
    connection.closed.then(()=>{if(!operationSettled)fault.fail('acp-connection-failed');});
    value=await Promise.race([result,fault.promise]);
  }catch(e){error=e instanceof AcpError?e:new AcpError(e?.code===-32000?'reviewer-auth-required':'acp-connection-failed');}
  finally{
    clearTimeout(timer);child.stdin.end();
    if(!closed)await Promise.race([close,sleep(500)]);
    if(closed)closeReason=exitCode===0?'graceful':'unexpected';
    else {child.kill();closeReason='controlled-stop';await Promise.race([close,sleep(2000)]);}
    if(route.read_access&&exitCode===LOW_LAUNCH_FAILED&&error)error=new AcpError('low-integrity-launch-failed');
    connection?.close();
    // A native endpoint may leave a descendant holding diagnostic pipe handles.
    // After ACP has ended and bounded shutdown has elapsed, release our ends so
    // the helper can exit. Its outer Windows Job then sweeps owned descendants.
    // This is not a claim that child.kill() alone cleans the process tree.
    child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
  }
  return {value,error,reviewerProcess:{exitCode,closeReason}};
}
async function initialize(ctx){
  const result=await ctx.request('initialize',{protocolVersion:PROTOCOL_VERSION,clientCapabilities:CAPABILITIES});
  if(result?.protocolVersion!==PROTOCOL_VERSION)throw new AcpError('protocol-version-mismatch');
  return result;
}
export async function runAcpInitialize(route,context){
  const result=await withEndpoint(route,{...context,hardDeadlineMs:duration(context.deadlineMs,10000)},initialize);
  if(result.error)throw result.error;if(!result.value)throw new AcpError('no-connection-outcome');
  return {initialized:true,protocolVersion:result.value.protocolVersion,
    agentCapabilities:{loadSession:result.value.agentCapabilities?.loadSession===true,promptCapabilities:{image:result.value.agentCapabilities?.promptCapabilities?.image===true,audio:result.value.agentCapabilities?.promptCapabilities?.audio===true,embeddedContext:result.value.agentCapabilities?.promptCapabilities?.embeddedContext===true}},
    authMethodsOffered:Array.isArray(result.value.authMethods)?result.value.authMethods.length:0,promptsSubmitted:0,reviewerProcess:result.reviewerProcess};
}

function authenticationMethods(init){
  if(!Array.isArray(init.authMethods)||init.authMethods.length>64)throw new AcpError('authentication-options-invalid');
  return init.authMethods.map(m=>{
    if(typeof m?.id!=='string'||!m.id||m.id.length>256||/[\x00-\x1f]/.test(m.id)
      ||typeof m.name!=='string'||m.name.length>256||/[\x00-\x1f]/.test(m.name))throw new AcpError('authentication-options-invalid');
    const type=m.type??'agent';
    if(typeof type!=='string'||!type||type.length>64||/[\x00-\x1f\x7f]/.test(type))throw new AcpError('authentication-options-invalid');
    return {id:m.id,name:m.name,type};
  });
}
async function authenticateSelection(ctx,init,route){
  const methodId=route.authentication?.method_id;
  if(typeof methodId!=='string'||!methodId)throw new AcpError('authentication-selection-required');
  const matches=authenticationMethods(init).filter(m=>m.id===methodId);
  if(matches.length!==1)throw new AcpError('authentication-method-unavailable');
  if(matches[0].type==='terminal')throw new AcpError('authentication-terminal-required');
  if(matches[0].type!=='agent')throw new AcpError('authentication-method-type-unsupported');
  // Only the advertised method ID crosses this boundary. The agent owns OAuth,
  // browser login and credential persistence; no credential is a tool argument.
  await ctx.request('authenticate',{methodId});
  return methodId;
}
export async function runAcpAuthenticate(route,context){
  if(!['inspect','login'].includes(context.mode))throw new AcpError('authentication-mode-invalid');
  const outcome=await withEndpoint(route,context,async ctx=>{
    const init=await initialize(ctx);
    if(context.mode==='inspect')return {status:'authentication-options',authMethods:authenticationMethods({...init,authMethods:init.authMethods??[]}),promptsSubmitted:0};
    const methodId=await authenticateSelection(ctx,init,route);
    return {status:'authenticated',methodId,promptsSubmitted:0};
  });
  if(outcome.error)throw outcome.error;
  if(!outcome.value)throw new AcpError('no-connection-outcome');
  if(outcome.reviewerProcess.closeReason==='unexpected')throw new AcpError('reviewer-process-failed');
  return {...outcome.value,reviewerProcess:outcome.reviewerProcess};
}

function mappedOption(route,options,intent){
  const mapping=route.configuration?.find(m=>m.intent===intent);
  if(mapping&&mapping.api!=='config-option')return {mapping,option:null};
  const matches=mapping?options.filter(o=>o.id===mapping.id):options.filter(o=>o.category===(intent==='model'?'model':'thought_level'));
  if(matches.length!==1)return {mapping,option:null};
  return {mapping,option:matches[0]};
}
function observedSettings(route,state){
  const observed=unknown();
  for(const intent of ['model','thinking']){
    const {mapping,option}=mappedOption(route,state.configOptions??[],intent);
    if(typeof option?.currentValue==='string')observed[intent]=option.currentValue;
    else if(mapping?.api==='mode'&&typeof state.modes?.currentModeId==='string')observed[intent]=state.modes.currentModeId;
    else if(mapping?.api==='model'&&typeof state.models?.currentModelId==='string')observed[intent]=state.models.currentModelId;
  }
  if(observed.model!==null||observed.thinking!==null)observed.source='provider-reported';return observed;
}
function selectValues(options){return (options??[]).flatMap(o=>Array.isArray(o.options)?o.options:[o]).map(o=>o.value);}
async function configureSelection(ctx,route,selection,state,sessionId){
  for(const intent of ['model','thinking']){
    const requested=selection?.[intent];if(requested?.source!=='user')continue;
    const {mapping,option}=mappedOption(route,state.configOptions??[],intent);
    if(!mapping?.evidence_ref)throw new AcpError('configuration-mapping-required');
    if(option){
      if(option.type!=='select'||!selectValues(option.options).includes(requested.value))throw new AcpError('configuration-value-unavailable');
      const response=await ctx.request('session/set_config_option',{sessionId,configId:option.id,value:requested.value});
      if(!Array.isArray(response.configOptions))throw new AcpError('configuration-confirmation-missing');
      state.configOptions=response.configOptions;
    }else if(mapping?.api==='mode'&&mapping.evidence_ref){
      if(!state.modes?.availableModes?.some(m=>m.id===requested.value))throw new AcpError('configuration-value-unavailable');
      await ctx.request('session/set_mode',{sessionId,modeId:requested.value});
      // Void setter reply is not applied-value evidence. Require notification.
    }else if(mapping?.api==='model'&&mapping.evidence_ref){
      if(!state.models?.availableModels?.some(m=>m.modelId===requested.value))throw new AcpError('configuration-value-unavailable');
      const response=await ctx.request('session/set_model',{sessionId,modelId:requested.value});
      if(response.models)state.models=response.models;
      if(response.configOptions)state.configOptions=response.configOptions;
    }else throw new AcpError('configuration-mapping-required');
    if(observedSettings(route,state)[intent]!==requested.value)throw new AcpError('configuration-confirmation-missing');
  }
}

// Reads are allowed for hash-bound snapshots and, in read-access runs, for files
// inside the run's read root. Every other request is rejected; in read-access
// runs Windows also refuses the writes themselves.
function permissionDecision(params,sessionId,snapshots,readRoot,recorded){
  let allowed=false,reason='outside-verified-read';
  const locations=params?.toolCall?.locations;
  if(params.sessionId===sessionId&&params.toolCall?.kind==='read'&&Array.isArray(locations)&&locations.length>0){
    const inRoot=!!readRoot&&locations.every(location=>{
      try{return within(readRoot,safePath(location.path,{exists:true,file:true}));}catch{return false;}
    });
    if(inRoot){allowed=true;reason='read-root';}
    else allowed=locations.every(location=>{
      try{
        const path=safePath(location.path,{exists:true,file:true});
        const authorized=snapshots.find(s=>typeof s.absolute_path==='string'&&s.absolute_path.toLowerCase()===path.toLowerCase());
        return !!authorized&&sha256Hex(readFileSync(path))===authorized.sha256;
      }catch{return false;}
    });
    if(allowed&&!inRoot)reason='hash-bound-read';
  }
  const option=(params.options??[]).find(o=>o.kind===(allowed?'allow_once':'reject_once'));
  recorded.push({decided:allowed&&option?'allowed':'denied',kind:params.toolCall?.kind??'unknown',reason:allowed&&option?reason:'outside-verified-read'});
  return option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}};
}
// The read root reaches the agent through the standard ACP session field only
// when the agent advertises it; otherwise the letter names absolute paths.
function sessionDirectories(init,readRoot){
  return readRoot&&init.agentCapabilities?.sessionCapabilities?.additionalDirectories!=null?{additionalDirectories:[readRoot]}:{};
}

export async function runAcpTurn(route,selection,promptBlocks,context){
  const deadline=duration(context.deadlineMs,600000),grace=duration(context.cancelGraceMs,10000);
  if(!Array.isArray(promptBlocks)||promptBlocks.some(b=>b.type!=='text'||typeof b.text!=='string'))throw new AcpError('unsupported-prompt-block');
  const readRoot=route.read_access&&typeof context.readRoot==='string'?context.readRoot:null;
  let replyText='',stopReason=null,nativeSessionRef=context.resumeRef??null,errorCode=null;
  let phase='initializing',promptsSubmitted=0,cancelRequested=false,timer,cancelTimer,abortHandler;
  let observed=unknown();const permissionDecisions=[];let state={};let connectionContext,fault;
  const cancel=()=>{
    if(cancelRequested)return;cancelRequested=true;
    if(phase==='prompt'&&connectionContext){connectionContext.notify('session/cancel',{sessionId:nativeSessionRef}).catch(()=>{});cancelTimer=setTimeout(()=>fault.fail('cancel-unconfirmed'),grace);}
    else fault?.fail('cancelled-before-prompt');
  };
  const outcome=await withEndpoint(route,{...context,hardDeadlineMs:deadline+grace},async(ctx,channel)=>{
    connectionContext=ctx;fault=channel;
    timer=setTimeout(cancel,deadline);
    abortHandler=cancel;context.signal?.addEventListener('abort',abortHandler,{once:true});
    if(context.signal?.aborted){cancel();throw new AcpError('cancelled-before-prompt');}
    const init=await initialize(ctx);
    if(route.authentication){phase='authenticating';await authenticateSelection(ctx,init,route);}
    if(context.resumeRef){
      if(init.agentCapabilities?.loadSession!==true)throw new AcpError('session-reconstruction-required');
      phase='loading';
      try{const loaded=await ctx.request('session/load',{sessionId:context.resumeRef,cwd:context.workDir,mcpServers:[],...sessionDirectories(init,readRoot),...(route.session_meta?{_meta:structuredClone(route.session_meta)}:{})});state={...state,...loaded};}
      catch{throw new AcpError('session-reconstruction-required');}
    }else{
      state=await ctx.request('session/new',{cwd:context.workDir,mcpServers:[],...sessionDirectories(init,readRoot),...(route.session_meta?{_meta:structuredClone(route.session_meta)}:{})});
      if(typeof state.sessionId!=='string'||!state.sessionId)throw new AcpError('session-id-missing');nativeSessionRef=state.sessionId;
    }
    if(errorCode)throw new AcpError(errorCode);
    phase='configuring';await configureSelection(ctx,route,selection,state,nativeSessionRef);observed=observedSettings(route,state);
    if(errorCode)throw new AcpError(errorCode);
    if(cancelRequested)throw new AcpError('cancelled-before-prompt');
    // Caller persists unknown before the only possible prompt.
    await context.beforePrompt?.();
    observed=observedSettings(route,state);
    if(['model','thinking'].some(k=>selection?.[k]?.source==='user'&&observed[k]!==selection[k].value))throw new AcpError('runtime-configuration-changed');
    phase='prompt';promptsSubmitted=1;
    const result=await ctx.request('session/prompt',{sessionId:nativeSessionRef,prompt:promptBlocks});
    phase='ended';stopReason=result?.stopReason??null;
    if(!['end_turn','refusal','max_tokens','max_turn_requests','cancelled'].includes(stopReason))throw new AcpError('invalid-stop-reason');
    if(stopReason==='end_turn'&&!replyText.trim())errorCode='empty-reply';
    return true;
  },(app,channel)=>{
    fault=channel;
    app.onNotification('session/update',({params})=>{
      if(!nativeSessionRef||params.sessionId!==nativeSessionRef){errorCode='session-correlation-mismatch';channel.fail(errorCode);return;}
      const update=params.update;
      if(update.sessionUpdate==='config_option_update')state.configOptions=update.configOptions;
      if(update.sessionUpdate==='current_mode_update')state.modes={...state.modes,currentModeId:update.currentModeId};
      if(update.sessionUpdate==='config_option_update'||update.sessionUpdate==='current_mode_update'){
        observed=observedSettings(route,state);
        if(phase==='prompt'&&['model','thinking'].some(k=>selection?.[k]?.source==='user'&&observed[k]!==selection[k].value)){errorCode='runtime-configuration-changed';channel.fail(errorCode);}
      }
      if(phase==='prompt'&&update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'){
        replyText+=update.content.text;
        if(Buffer.byteLength(replyText,'utf8')>16*1024*1024){channel.fail('reply-size-limit');return;}
        try{context.onUpdate?.(params,replyText);}catch{channel.fail('partial-save-failed');}
      }
    });
    app.onRequest('session/request_permission',({params})=>permissionDecision(params,nativeSessionRef,context.authorizedSnapshots??[],readRoot,permissionDecisions));
  });
  clearTimeout(timer);clearTimeout(cancelTimer);if(abortHandler)context.signal?.removeEventListener('abort',abortHandler);
  if(outcome.error)errorCode=errorCode??outcome.error.code;
  if(promptsSubmitted&&['model','thinking'].some(k=>selection?.[k]?.source==='user'&&observed[k]!==selection[k].value))errorCode=errorCode??'runtime-configuration-changed';
  if(outcome.reviewerProcess.closeReason==='unexpected'&&!errorCode)errorCode='reviewer-process-failed';
  return {replyText,stopReason,nativeSessionRef,continuity:context.resumeRef?'native-resume':context.continuity??'new',observed,errorCode,cancelRequested,promptsSubmitted,permissionDecisions,reviewerProcess:outcome.reviewerProcess};
}
