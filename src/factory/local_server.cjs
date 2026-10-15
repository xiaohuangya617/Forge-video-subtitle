const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {killTree}=require('./recognition.cjs');
const DEFAULT_MODEL_NAME='Hy-MT2-1.8B-Q4_K_M.gguf';

function loopbackHost(host){return host==='127.0.0.1'||host==='localhost'||host==='::1'}
function serviceInfo(base){const u=new URL(base||'http://127.0.0.1:8092/v1');if(!['http:','https:'].includes(u.protocol))throw Error('本地接口必须是 HTTP/HTTPS 地址');const host=u.hostname;const port=Number(u.port||((u.protocol==='https:')?443:80));if(!Number.isInteger(port)||port<1||port>65535)throw Error('本地接口端口无效');return {url:u,host,port,loopback:loopbackHost(host)}}
function modelsUrl(base){const u=new URL(base||'http://127.0.0.1:8092/v1');u.pathname=u.pathname.replace(/\/+$/,'')+'/models';u.search='';u.hash='';return u.toString()}
async function probe(base,signal,timeout=800){const controller=new AbortController();const abort=()=>controller.abort(signal?.reason);if(signal){if(signal.aborted)throw signal.reason||Error('任务已取消');signal.addEventListener('abort',abort,{once:true})}const timer=setTimeout(()=>controller.abort(),timeout);try{const response=await fetch(modelsUrl(base),{method:'GET',redirect:'error',signal:controller.signal});return !!response?.ok}catch(e){if(signal?.aborted)throw signal.reason||Error('任务已取消');return false}finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort)}}
async function probeIdentity(base,expected,signal,timeout=1200){const controller=new AbortController();const abort=()=>controller.abort(signal?.reason);if(signal){if(signal.aborted)throw signal.reason||Error('任务已取消');signal.addEventListener('abort',abort,{once:true})}const timer=setTimeout(()=>controller.abort(),timeout);try{const response=await fetch(modelsUrl(base),{method:'GET',redirect:'error',signal:controller.signal});if(!response?.ok)return {available:false,matches:false,reason:`HTTP ${response?.status||'未知'}`};let body;try{body=await response.json()}catch{return {available:true,matches:false,reason:'模型服务返回不是有效 JSON'}}const models=Array.isArray(body?.data)?body.data:[];const expectedName=path.basename(String(expected||'')).replace(/\.gguf$/i,'').toLowerCase();const ids=models.map(item=>String(item?.id||item?.model||item?.name||'').toLowerCase()).filter(Boolean);const matches=!expectedName||ids.some(id=>id.includes(expectedName)||expectedName.includes(id));return {available:true,matches,models:ids,reason:matches?'':'模型身份不匹配'} }catch(e){if(signal?.aborted)throw signal.reason||Error('任务已取消');return {available:false,matches:false,reason:e?.message||'连接失败'}}finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort)}}
function candidateRuntimes({appDir,modelPath}){const modelDir=path.dirname(modelPath||'');const candidates=[];if(process.env.SUBTITLE_FACTORY_LLAMA_SERVER)candidates.push(process.env.SUBTITLE_FACTORY_LLAMA_SERVER);candidates.push(path.join(appDir,'runtime','llama-server.exe'));candidates.push(path.resolve(appDir,'..','runtime','llama-server.exe'));candidates.push(path.join(modelDir,'llama-server.exe'));candidates.push(path.join(modelDir,'llama-b11541-bin-win-cpu-x64','llama-server.exe'));return [...new Set(candidates.filter(Boolean))]}
async function findModel({resources,appDir,configured=''}){const candidates=[];const add=p=>{if(p)candidates.push(p)};const name=DEFAULT_MODEL_NAME;add(path.join(resources||'', '..','models',name));add(path.join(appDir||'', '..','models',name));if(process.env.SUBTITLE_FACTORY_HYMT2_MODEL)add(process.env.SUBTITLE_FACTORY_HYMT2_MODEL);if(configured)add(configured);for(const file of [...new Set(candidates)]){try{const stat=await fs.stat(file);if(stat.isFile()&&/\.gguf$/i.test(file))return path.resolve(file)}catch{}}return ''}
async function findRuntime(options){for(const file of candidateRuntimes(options)){try{const stat=await fs.stat(file);if(stat.isFile())return file}catch{}}if(process.platform==='win32'){const found=await new Promise(resolve=>execFile('where.exe',['llama-server.exe'],{windowsHide:true},(error,stdout)=>resolve(error?'':String(stdout).split(/\r?\n/).map(s=>s.trim()).find(Boolean)||'')));if(found)return found}return ''}
function killProcess(child){return killTree(child)}
async function rotateLog(file,maxBytes=32*1024*1024){try{const stat=await fs.stat(file);if(stat.size<=maxBytes)return;const rotated=file+'.1';await fs.rm(rotated,{force:true});await fs.rename(file,rotated)}catch(e){if(e.code!=='ENOENT'){} }}
function wait(ms,signal){return new Promise((resolve,reject)=>{let timer=setTimeout(done,ms);function done(){if(signal)signal.removeEventListener('abort',abort);resolve()}function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason||Error('任务已取消'))}if(signal){if(signal.aborted)return abort();signal.addEventListener('abort',abort,{once:true})}})}

class LocalServer{
 constructor(){this.child=null;this.owned=false;this.stdout=null;this.stderr=null;this.logDir=''}
 async ensure({settings,appDir,dataDir,signal,onStatus=()=>{}}){
  signal?.throwIfAborted();
  if(this.child) return true;
  const info=serviceInfo(settings.localBaseurl);if(!info.loopback)throw Error('本地模型自动启动只支持 127.0.0.1、localhost 或 ::1；远程地址请自行启动服务');if(info.url.protocol!=='http:')throw Error('本地模型自动启动需要使用 HTTP 接口；HTTPS 地址请自行启动服务');
  onStatus({status:'checking'});const identity=await probeIdentity(settings.localBaseurl,settings.localModelPath,signal);if(identity.available){if(!identity.matches)throw Error('已有本地模型服务，但实际模型不是 Hy-MT2；请关闭占用该端口的服务后重试');onStatus({status:'reused'});return false}
  const runtime=await findRuntime({appDir,modelPath:settings.localModelPath});
  signal?.throwIfAborted();
  if(!runtime)throw Error('找不到 llama-server.exe。请将运行时放入软件 resources\\runtime，或放在 Hy-MT2 模型同目录后重试');
  onStatus({status:'starting'});
  await fs.mkdir(dataDir,{recursive:true});
  const logBase=path.join(dataDir,'hymt2-server');
  await rotateLog(logBase+'.log');await rotateLog(logBase+'.err.log');this.logDir=logBase;this.stdout=await fs.open(logBase+'.log','a');this.stderr=await fs.open(logBase+'.err.log','a');
   const threads=settings.cpuMode==='balanced'?Math.max(2,Math.floor(((require('node:os').cpus()?.length||4)*3)/4)):6;
   const args=['-m',settings.localModelPath,'--host',info.host,'--port',String(info.port),'-c','4096','-t',String(threads)];
  let child;try{signal?.throwIfAborted();child=spawn(runtime,args,{cwd:path.dirname(runtime),windowsHide:true,stdio:['ignore',this.stdout.createWriteStream(),this.stderr.createWriteStream()]})}catch(e){await this.close();throw Error('启动 llama-server 失败：'+e.message)}
  this.child=child;this.owned=true;let earlyError='';let closed=false;
  const onError=e=>{earlyError=e?.message||String(e);closed=true};const onClose=()=>{closed=true};child.once('error',onError);child.once('close',onClose);
  try{const deadline=Date.now()+120000;while(Date.now()<deadline){if(signal?.aborted)throw signal.reason||Error('任务已取消');if(closed)throw Error(earlyError||'llama-server 提前退出，请查看 hymt2-server.err.log');if(await probe(settings.localBaseurl,signal,1200)){onStatus({status:'ready'});return true}await wait(250,signal)}throw Error('llama-server 启动超时，请查看 hymt2-server.err.log')}catch(e){await this.close();if(e?.message==='任务已取消')throw e;throw Error(e.message)}
 }
 async recover(options){
  const {settings,signal,onStatus=()=>{}}=options;
  if(this.child||this.owned){onStatus({status:'recovering'});await this.close();return this.ensure(options)}
  if(await probe(settings.localBaseurl,signal)){onStatus({status:'recovered'});return false}
  throw Error('本地翻译服务已断开，当前服务不是软件启动的，无法自动重启；请重新启动 llama-server 后重试')
 }
 async close(){const child=this.child;this.child=null;const owned=this.owned;this.owned=false;if(child&&owned)await killProcess(child);try{await this.stdout?.close()}catch{}try{await this.stderr?.close()}catch{}this.stdout=null;this.stderr=null;const logBase=this.logDir||'';if(logBase){await rotateLog(logBase+'.log');await rotateLog(logBase+'.err.log')}this.logDir=''}
}

module.exports={LocalServer,serviceInfo,probe,probeIdentity,findRuntime,candidateRuntimes,findModel,DEFAULT_MODEL_NAME};
