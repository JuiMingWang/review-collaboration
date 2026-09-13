import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {safePath,privateWritable} from '../scripts/lib/safe-files.mjs';
import {initProject,createTopic} from '../scripts/lib/mail-store.mjs';

test('S02 paths reject traversal, sibling prefix, junction, UNC and ADS',t=>{
  const root=mkdtempSync(join(tmpdir(),'safe-mail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const record=join(root,'records'),other=join(root,'records-other');mkdirSync(record);mkdirSync(other);writeFileSync(join(other,'secret.txt'),'synthetic canary');
  for(const p of [record+'\\..\\records-other',record+':stream','\\\\host\\records',record+'\\NUL',record+'\\trailing.'])assert.throws(()=>safePath(p),{code:'unsafe-path'});
  assert.throws(()=>safePath(other,{within:record}),{code:'unsafe-path'});
  const link=join(record,'link');symlinkSync(other,link,'junction');
  assert.throws(()=>safePath(join(link,'secret.txt')),{code:'unsafe-path'});
  assert.equal(readFileSync(join(other,'secret.txt'),'utf8'),'synthetic canary');
});

test('S06 private root unavailable fails instead of falling back elsewhere',t=>{
  const root=mkdtempSync(join(tmpdir(),'private-mail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'_private');writeFileSync(path,'synthetic occupied file');
  assert.throws(()=>privateWritable(path),{code:'private-root-unavailable'});
  assert.equal(readFileSync(path,'utf8'),'synthetic occupied file');
});

test('S07 real isolated Git repository blocks tracked private data and records',async t=>{
  const root=mkdtempSync(join(tmpdir(),'tracked-mail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=args=>{const r=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true,shell:false,timeout:5000});assert.equal(r.status,0,r.stderr);return r.stdout;};
  git(['init','--quiet']);
  const priv=join(root,'_private');privateWritable(priv);writeFileSync(join(priv,'synthetic.json'),'{}');
  assert.equal(git(['status','--porcelain','--untracked-files=all']),'');
  writeFileSync(join(priv,'.gitignore'),'');assert.throws(()=>privateWritable(priv),{code:'private-ignore-unverified'});writeFileSync(join(priv,'.gitignore'),'*\n');
  git(['add','-f','--','_private/synthetic.json']);assert.throws(()=>privateWritable(priv),{code:'private-root-git-tracked'});
  const project=await initProject(root);
  writeFileSync(join(project.record_root,'.gitignore'),'');await assert.rejects(createTopic(project.record_root,{title:'unprotected'}),{code:'private-ignore-unverified'});writeFileSync(join(project.record_root,'.gitignore'),'*\n');
  git(['add','-f','--','.review-collaboration/project.json']);
  await assert.rejects(createTopic(project.record_root,{title:'must be blocked'}),{code:'record-root-git-tracked'});
});
