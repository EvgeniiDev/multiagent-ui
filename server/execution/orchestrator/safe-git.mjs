// Git treats worker-controlled configuration as executable. Host processing
// instead uses a private gitdir containing only refs/index and trusted config.
import {promises as fs,constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const locks=new Map();
function environment(extra={}) {
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
 for(const [k,v] of Object.entries(extra))if(!k.startsWith('GIT_')||/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(k))env[k]=v;
 return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
}
function run(cwd,args,{env,input,binary=false,objectFd}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn('git',args,{cwd,env,shell:false,stdio:objectFd===undefined?['pipe','pipe','pipe']:['pipe','pipe','pipe',objectFd]});const out=[],err=[];
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);const b=Buffer.concat(out);resolve({code,stdout:binary?b:b.toString('utf8'),stderr:Buffer.concat(err).toString('utf8')});});
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
async function optional(p){try{return await fs.lstat(p);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function copyMetadata(source,target){
 const st=await optional(source);if(!st)return;
 if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))throw new Error('Unsafe Git metadata type');
 if(st.isDirectory()){await fs.mkdir(target,{recursive:true,mode:0o700});for(const name of await fs.readdir(source))await copyMetadata(path.join(source,name),path.join(target,name));}
 else {await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.copyFile(source,target);}
}
async function locate(repo){
 let dir=path.join(repo,'.git');const st=await optional(dir);
 if(!st)throw new Error('Repository Git directory absent');
 if(st.isSymbolicLink())throw new Error('Symlink Git directory rejected');
 if(st.isFile()){const text=await fs.readFile(dir,'utf8');const m=/^gitdir: ([^\r\n]+)\s*$/.exec(text);if(!m)throw new Error('Invalid Git pointer');dir=path.resolve(repo,m[1]);}
 dir=await fs.realpath(dir);let common=dir;
 const c=await optional(path.join(dir,'commondir'));if(c){if(!c.isFile())throw new Error('Invalid common Git directory');common=await fs.realpath(path.resolve(dir,(await fs.readFile(path.join(dir,'commondir'),'utf8')).trim()));}
 const objects=path.join(common,'objects');const ost=await fs.lstat(objects);if(!ost.isDirectory()||ost.isSymbolicLink())throw new Error('Unsafe Git object directory');
 const alternates=path.join(objects,'info','alternates');if(await optional(alternates)){if((await fs.readFile(alternates,'utf8')).trim())throw new Error('Git alternates rejected');}
 return {dir,common,objects};
}
async function persistMetadata(source,target){
 const st=await optional(source);if(!st)return;
 if(st.isDirectory()){const dst=await optional(target);if(dst?.isSymbolicLink())throw new Error('Unsafe Git metadata destination');await fs.mkdir(target,{recursive:true,mode:0o700});for(const name of await fs.readdir(source))await persistMetadata(path.join(source,name),path.join(target,name));return;}
 const dst=await optional(target);if(dst?.isSymbolicLink())throw new Error('Unsafe Git metadata destination');
 const tmp=`${target}.safe-${process.pid}`;await fs.copyFile(source,tmp);await fs.rename(tmp,target);
}
async function publishObjects(source,target){
 const handle=await fs.open(target,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const anchor=`/proc/self/fd/${handle.fd}`;
 try{for(const name of await fs.readdir(source)){
  const src=path.join(source,name),dst=path.join(anchor,name),st=await fs.lstat(src);
  if(st.isSymbolicLink())throw new Error('Symlink Git object rejected');
  if(st.isDirectory()){
   const old=await optional(dst);if(old&&!old.isDirectory())throw new Error('Unsafe Git object shard');
   if(!old)await fs.mkdir(dst,{mode:0o700});await publishObjects(src,dst);
  }else if(st.isFile()){
   const old=await optional(dst);if(old){if(!old.isFile()||old.isSymbolicLink())throw new Error('Unsafe Git object leaf');continue;}
   const temp=path.join(anchor,`.object-${process.pid}-${Date.now()}`);await fs.copyFile(src,temp);await fs.rename(temp,dst);
  }else throw new Error('Unsafe Git object type');
 }}finally{await handle.close();}
}

async function execute(repo,args,opts){
 let commandIndex=0;while(args[commandIndex]==='-c')commandIndex+=2;const command=args[commandIndex];
 const mutation=['add','commit','write-tree','reset','update-index','update-ref','checkout','branch','fetch','clean'].includes(command);
 const env=environment(opts.env);const options=['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','tag.gpgSign=false'];
 if(command==='init'){
  if(await optional(path.join(repo,'.git')))throw new Error('Existing Git directory cannot be reinitialized');
  return run(repo,[...options,'-c','init.templateDir=',...args],{...opts,env});
 }
 const loc=await locate(repo);
 if(mutation&&(loc.dir!==path.join(repo,'.git')||loc.common!==loc.dir))throw new Error('Mutation requires autonomous private Git directory');
 if(command==='worktree'&&args[commandIndex+1]==='list'){
  const registered=await optional(path.join(loc.common,'worktrees'));
  const rows=[`worktree ${repo}`];
  if(registered){for(const name of await fs.readdir(path.join(loc.common,'worktrees')))rows.push(`worktree registered:${name}`);}
  return {code:0,stdout:rows.join('\n\n')+'\n',stderr:''};
 }
 if(args.length===2&&args[0]==='rev-parse'&&['--git-dir','--git-common-dir'].includes(args[1]))return {code:0,stdout:`${args[1]==='--git-dir'?loc.dir:loc.common}\n`,stderr:''};
 const sourceHandle=await fs.open(loc.dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const commonHandle=loc.common===loc.dir?sourceHandle:await fs.open(loc.common,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
 const sourceAnchor=`/proc/self/fd/${sourceHandle.fd}`,commonAnchor=`/proc/self/fd/${commonHandle.fd}`;
 const shadow=await fs.mkdtemp(path.join(os.tmpdir(),'acp-safe-git-'));
 try{
  const init=await run(shadow,[...options,'init','--bare','-q'],{env});if(init.code!==0)throw new Error(init.stderr);
  for(const name of ['HEAD','index','shallow'])await copyMetadata(path.join(sourceAnchor,name),path.join(shadow,name));
  for(const name of await fs.readdir(sourceAnchor))if(/^sharedindex\.[0-9a-f]+$/.test(name))await copyMetadata(path.join(sourceAnchor,name),path.join(shadow,name));
  for(const name of ['refs','packed-refs'])await copyMetadata(path.join(commonAnchor,name),path.join(shadow,name));
  await fs.rm(path.join(shadow,'objects'),{recursive:true,force:true});
  await copyMetadata(path.join(commonAnchor,'objects'),path.join(shadow,'objects'));
  const gitEnv=env;
  if(command==='add'){
   const rebuilt=await run(repo,[`--git-dir=${shadow}`,`--work-tree=${repo}`,...options,'read-tree','HEAD'],{env:gitEnv});
   if(rebuilt.code!==0){const empty=await run(repo,[`--git-dir=${shadow}`,`--work-tree=${repo}`,...options,'read-tree','--empty'],{env:gitEnv});if(empty.code!==0)throw new Error(empty.stderr);}
  }
  const actual=command==='diff'?[...args.slice(0,commandIndex),command,'--no-ext-diff','--no-textconv',...args.slice(commandIndex+1)]:args;
  const result=await run(repo,[`--git-dir=${shadow}`,`--work-tree=${repo}`,...options,'-c','core.bare=false',...actual],{...opts,env:gitEnv});
  // Preserve normal Git autonomy only for successful trusted mutation calls.
  if(result.code===0&&mutation){
   await publishObjects(path.join(shadow,'objects'),path.join(commonAnchor,'objects'));
   for(const name of await fs.readdir(shadow))if(/^sharedindex\.[0-9a-f]+$/.test(name))await persistMetadata(path.join(shadow,name),path.join(sourceAnchor,name));
   for(const name of ['HEAD','index','packed-refs'])await persistMetadata(path.join(shadow,name),path.join(sourceAnchor,name));
   const replacement=path.join(sourceAnchor,`refs.safe-${process.pid}`);
   await fs.rm(replacement,{recursive:true,force:true});await copyMetadata(path.join(shadow,'refs'),replacement);
   await fs.rm(path.join(sourceAnchor,'refs'),{recursive:true,force:true});await fs.rename(replacement,path.join(sourceAnchor,'refs'));
  }
  return result;
 }finally{await fs.rm(shadow,{recursive:true,force:true});if(commonHandle!==sourceHandle)await commonHandle.close();await sourceHandle.close();}
}
export async function safeGit(cwd,args,opts={}){
 const repo=await fs.realpath(cwd);const before=locks.get(repo)??Promise.resolve();
 const current=before.catch(()=>{}).then(()=>execute(repo,args,opts));locks.set(repo,current);
 try{return await current;}finally{if(locks.get(repo)===current)locks.delete(repo);}
}
