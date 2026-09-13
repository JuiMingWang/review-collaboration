import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertSelection, assertUuid, fail } from './mail-contract.mjs';
import { acquireMetadataLock } from './mail-store.mjs';
import { fields, safePath, readJSON, writeJSON, privateWritable } from './safe-files.mjs';
import { loadRoute } from './acp-route.mjs';

const aliases=new Map(Object.entries({codex:'codex','codex.cmd':'codex','codex.exe':'codex',claude:'claude','claude code':'claude','claude-code':'claude','claude.exe':'claude',pi:'pi','pi agent':'pi','pi-agent':'pi',agy:'antigravity',antigravity:'antigravity'}));
const validId=id=>typeof id==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(id);
function identityRecords(root){
  if(!root||!existsSync(join(root,'identities')))return [];
  safePath(join(root,'identities'),{exists:true});
  return readdirSync(join(root,'identities')).filter(n=>/^[a-z][a-z0-9-]{0,63}\.json$/.test(n)).map(n=>readJSON(join(root,'identities',n)));
}
export function normalizeIdentity(value,privateRoot=null){
  if(typeof value!=='string'||/[\\/:\0]/.test(value))fail('invalid-identity','identity is not a path');
  const key=value.trim().toLowerCase();if(aliases.has(key))return aliases.get(key);
  if(!validId(key))fail('invalid-identity','use a stable tool identity');
  for(const rec of identityRecords(privateRoot))if(rec.schema_version===1&&rec.source_url?.startsWith('https://')&&rec.source_revision&&rec.evidence&&validId(rec.canonical_id)&&[rec.canonical_id,...(rec.aliases??[])].includes(key))return rec.canonical_id;
  fail('identity-evidence-required','unknown tool; record canonical identity and upstream evidence first');
}

export function saveIdentity(root,record){
  fields(record,['schema_version','canonical_id','aliases','source_url','source_revision','evidence']);
  if(record.schema_version!==1||!validId(record.canonical_id)||!Array.isArray(record.aliases)||record.aliases.some(a=>!validId(a))||!record.source_url.startsWith('https://')||!record.source_revision||!record.evidence)fail('invalid-identity','identity evidence incomplete');
  privateWritable(root);mkdirSync(join(root,'identities'),{recursive:true});
  const lock=acquireMetadataLock(join(root,'identities.lock'),'identity');
  try{
    const keys=[record.canonical_id,...record.aliases];
    for(const key of keys){if(aliases.has(key)&&aliases.get(key)!==record.canonical_id)fail('identity-alias-conflict','alias belongs to another tool');}
    for(const rec of identityRecords(root))if(rec.canonical_id!==record.canonical_id&&[rec.canonical_id,...rec.aliases].some(k=>keys.includes(k)))fail('identity-alias-conflict','alias already recorded');
    writeJSON(join(root,'identities',record.canonical_id+'.json'),record);
  }finally{lock.release();}
}

function selectionFor(root,selection,host=null){
  fields(selection,['host_id','reviewer_tool_id','route_id','model','thinking']);assertSelection(selection);
  for(const field of ['model','thinking']){fields(selection[field],['source','value']);if(selection[field].source==='user'&&!selection[field].value.trim())fail('invalid-selection','explicit setting must not be empty');}
  const actualHost=normalizeIdentity(selection.host_id,root);const reviewer=normalizeIdentity(selection.reviewer_tool_id,root);
  if(host&&actualHost!==normalizeIdentity(host,root))fail('host-selection-mismatch','selection belongs to another host');
  if(actualHost===reviewer)fail('same-tool-review','the host and reviewer must be different tools');
  assertUuid(selection.route_id,'route_id');
  const route=loadRoute(root,selection.route_id);
  if(normalizeIdentity(route.reviewer_tool_id,root)!==reviewer)fail('route-identity-mismatch','route belongs to another reviewer');
  return {...structuredClone(selection),host_id:actualHost,reviewer_tool_id:reviewer};
}

export async function readProfile(root,hostId){
  const host=normalizeIdentity(hostId,root);const path=join(root,'hosts',host+'.json');
  if(!existsSync(path))return null;
  const profile=readJSON(path);
  fields(profile,['schema_version','host_id','revision','default_reviewer']);
  if(profile.schema_version!==2||profile.host_id!==host||!Number.isSafeInteger(profile.revision)||profile.revision<1)fail('invalid-profile','profile schema/revision mismatch');
  return {...profile,default_reviewer:selectionFor(root,profile.default_reviewer,host)};
}
export async function resolveSelection(root,hostId){return (await readProfile(root,hostId))?.default_reviewer??null;}
export async function selectOnce(root,hostId,override=null){return override?selectionFor(root,override,hostId):resolveSelection(root,hostId);}
export async function saveProfile(root,selection,expectedRevision){
  const selected=selectionFor(root,selection);
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail('invalid-revision','expected_revision must be a nonnegative integer');
  privateWritable(root);mkdirSync(join(root,'hosts'),{recursive:true});
  const path=join(root,'hosts',selected.host_id+'.json');const lock=acquireMetadataLock(join(root,'hosts',selected.host_id+'.lock'),'profile');
  try{
    const previous=existsSync(path)?readJSON(path):null;
    if(previous&&(previous.schema_version!==2||previous.host_id!==selected.host_id))fail('invalid-profile','existing profile is not schema 2');
    if((previous?.revision??0)!==expectedRevision)fail('profile-revision-mismatch','another writer changed this profile');
    const revision=expectedRevision+1;writeJSON(path,{schema_version:2,host_id:selected.host_id,revision,default_reviewer:selected});return revision;
  }finally{lock.release();}
}

export function importLegacy(path){
  const old=readJSON(path);if(old.schema_version!==1)fail('legacy-schema-unsupported','expected schema 1');
  return {reviewer_candidate:typeof old.reviewer==='string'?old.reviewer:null,route:null,requires_acp_verification:true};
}
