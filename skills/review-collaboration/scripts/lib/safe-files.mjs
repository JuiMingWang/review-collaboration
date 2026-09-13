// Local ordinary paths only. These checks are admission guards, not an OS
// sandbox against a hostile process replacing paths after they were checked.
import { lstatSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, accessSync, constants } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail, jsonBytes, newUuid, decodeUtf8Strict } from './mail-contract.mjs';

export function safePath(path, {exists=false, file=false, within=null}={}) {
  if(typeof path!=='string'||! /^[a-zA-Z]:[\\/]/.test(path)||path.includes('\0')||path.slice(2).includes(':')) fail('unsafe-path','expected a local absolute path without streams');
  const parts=path.slice(3).split(/[\\/]/);
  if(parts.some(p=>p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('unsafe-path','unsafe path component');
  const clean=normalize(path);
  if(within){const r=relative(normalize(within),clean);if(r==='..'||r.startsWith('..\\')||/^[a-z]:/i.test(r)) fail('unsafe-path','path outside authorized root');}
  let current=clean;
  while(true){
    try {const s=lstatSync(current);if(s.isSymbolicLink()||(!s.isFile()&&!s.isDirectory())) fail('unsafe-path','link or non-ordinary path');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  if(exists&&!existsSync(clean))fail('dependency-missing','required local file or directory is missing');
  if(file&&existsSync(clean)&&!lstatSync(clean).isFile())fail('unsafe-path','expected a regular file');
  return clean;
}

export function readJSON(path) {
  safePath(path,{exists:true,file:true});
  try{return JSON.parse(decodeUtf8Strict(readFileSync(path),'JSON file'));}
  catch(e){if(e.code)throw e;fail('invalid-json','file is not valid JSON');}
}

export function writeJSON(path,value,{exclusive=false}={}) {
  safePath(path,{file:true});
  if(exclusive){writeFileSync(path,jsonBytes(value),{flag:'wx'});return;}
  const tmp=path+'.'+newUuid()+'.tmp';const fd=openSync(tmp,'wx');
  try{writeFileSync(fd,jsonBytes(value));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);
}

export function privateWritable(root) {
  safePath(root);
  // Do not persist preferences/evidence into an already tracked directory.
  let cursor=dirname(root);let repository=null;
  while(true){if(existsSync(join(cursor,'.git'))){repository=cursor;break;}const p=dirname(cursor);if(p===cursor)break;cursor=p;}
  if(repository){
    const run=spawnSync('git',['-C',repository,'ls-files','--',relative(repository,root)],{encoding:'utf8',timeout:5000,windowsHide:true,shell:false});
    if(run.error||run.status!==0)fail('private-root-git-unknown','cannot establish tracking state');
    if(run.stdout.trim())fail('private-root-git-tracked','private configuration is tracked');
  }
  try{mkdirSync(root,{recursive:true});accessSync(root,constants.W_OK);}
  catch(e){fail('private-root-unavailable','private configuration directory is not writable');}
  ensurePrivateIgnore(root);
}

export function ensurePrivateIgnore(root){
  const path=join(root,'.gitignore');safePath(path,{file:true});
  if(!existsSync(path)){
    try{writeFileSync(path,'*\n',{flag:'wx'});}catch(e){if(e.code!=='EEXIST')fail('private-root-unavailable','cannot write private ignore guard');}
  }
  if(readFileSync(path,'utf8').trim()!=='*')fail('private-ignore-unverified','private .gitignore was changed; restore its single * rule before writing');
}

export function fields(value, allowed, required=allowed, label='request') {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('invalid-request',`${label} must be an object`);
  for(const key of Object.keys(value))if(!allowed.includes(key))fail('unknown-field',`${label}.${key}`);
  for(const key of required)if(!Object.hasOwn(value,key))fail('missing-field',`${label}.${key}`);
  return value;
}
