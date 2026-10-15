const fs=require('node:fs/promises'),path=require('node:path');
const defaults={
 recognitionEnabled:true,recognitionMode:'local',recognitionKey:'',recognitionModel:'qwen-audio-3.0-asr-flash-filetrans',recognitionBaseurl:'https://dashscope.aliyuncs.com/api/v1',recognitionPrompt:'日本語の映画・ドラマの自然な会話。日常会話、人物の名前、呼びかけ、短い返事。',recognitionTimeout:120000,recognitionRetries:2,
 cpuMode:'performance',trayOnClose:false,translationEnabled:true,translationMode:'local',localBaseurl:'http://127.0.0.1:8092/v1',key:'',model:'deepseek-flash',baseurl:'https://api.deepseek.com',language:'中文',timeout:120000,tokens:8192,retries:2,prompt:'请将字幕翻译为自然流畅的中文，保留人物语气和称呼，不遗漏、不合并字幕条目。',genDir:''
};
const oldFields=['dialogueOnly','useHints','asr','scene','hotwords','context'];
function validate(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('设置内容必须为对象');
 const out={...defaults};
 for(const k of Object.keys(defaults)){
  if(!(k in raw))continue;const v=raw[k];
  if(typeof defaults[k]==='boolean'){if(typeof v!=='boolean')throw Error(k+' 必须是开关值');out[k]=v;continue}
  if(typeof defaults[k]==='number'){
   const min=k.endsWith('Retries')||k==='retries'?0:1000,max=k.endsWith('Retries')||k==='retries'?10:k==='tokens'?1000000:3600000,n=Number(v);
   if((typeof v!=='number'&&typeof v!=='string')||(typeof v==='string'&&!v.trim())||!Number.isInteger(n)||n<min||n>max)throw Error(k+' 超出有效范围');out[k]=n;continue
  }
  if(typeof v!=='string'||v.length>100000)throw Error(k+' 格式无效');out[k]=v;
 }
 if(!['local','cloud'].includes(out.recognitionMode))throw Error('不支持的识别方式');
 if(!['local','cloud'].includes(out.translationMode))throw Error('不支持的翻译方式');
 if(typeof out.recognitionEnabled!=='boolean')throw Error('recognitionEnabled 必须是开关值');
 if(typeof out.trayOnClose!=='boolean')throw Error('trayOnClose 必须是开关值');
 if(!['performance','balanced'].includes(out.cpuMode))throw Error('不支持的本机处理模式');
 if(out.recognitionEnabled&&out.recognitionMode==='cloud'){
  if(!out.recognitionKey.trim())throw Error('请填写识别 API Key');
  if(!out.recognitionModel.trim())throw Error('识别模型名称不能为空');
  validateUrl(out.recognitionBaseurl,'识别 Base URL');
  if(!out.recognitionBaseurl.replace(/\/+$/,'').endsWith('/api/v1'))throw Error('识别 Base URL 请填写至 /api/v1');
 }
 if(out.translationEnabled){
  const base=out.translationMode==='local'?out.localBaseurl:out.baseurl;validateUrl(base,out.translationMode==='local'?'本地接口':'Base URL');
  if(out.translationMode==='cloud'&&!out.model.trim())throw Error('模型名称不能为空');
  if(out.translationMode==='local')out.language='中文';
 }
 if(!['中文','英语','日语'].includes(out.language))throw Error('不支持的目标语言');
 return out;
}
function validateUrl(value,label){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error()}catch{throw Error(label+' 必须是有效的 HTTP/HTTPS 地址')}}
function migrate(raw,version){const data={...(raw||{})};for(const k of oldFields)delete data[k];if(!('recognitionMode' in data))data.recognitionMode='local';if(version===1&&Number(data.timeout)===30000)data.timeout=defaults.timeout;return data;}
function createStore(file,safe){let writes=Promise.resolve();const store={async save(raw){const data=validate(raw);let encryptedKey='',encryptedRecognitionKey='';if(data.key||data.recognitionKey){if(!safe.isEncryptionAvailable())throw Error('系统加密不可用，设置未保存');if(data.key)encryptedKey=safe.encryptString(data.key).toString('base64');if(data.recognitionKey)encryptedRecognitionKey=safe.encryptString(data.recognitionKey).toString('base64')}delete data.key;delete data.recognitionKey;await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify({format:'subtitle-factory-settings',version:3,settings:data,encryptedKey,encryptedRecognitionKey},null,2),'utf8');await fs.rename(temp,file);return true;},async load(){let raw;try{raw=JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw Error('本机设置损坏，请重新保存或导入')}let key='',recognitionKey='';if(raw.encryptedKey){try{key=safe.decryptString(Buffer.from(raw.encryptedKey,'base64'))}catch{throw Error('无法解密本机翻译 API Key，请重新填写')}}if(raw.encryptedRecognitionKey){try{recognitionKey=safe.decryptString(Buffer.from(raw.encryptedRecognitionKey,'base64'))}catch{throw Error('无法解密本机识别 API Key，请重新填写')}}return validate({...migrate(raw.settings,raw.version??1),key,recognitionKey});}};const save=store.save;store.save=raw=>{const snapshot=validate(raw);writes=writes.catch(()=>{}).then(()=>save(snapshot));return writes;};store.flush=()=>writes;return store;}
function exportText(raw){const data=validate(raw);delete data.key;delete data.recognitionKey;return JSON.stringify({format:'subtitle-factory-settings',version:3,settings:data},null,2)}
function importText(text,current={}){
 let raw;try{raw=JSON.parse(text.replace(/^\uFEFF/,''))}catch{throw Error('不是有效的 JSON 设置文件')}
 if(raw.format!=='subtitle-factory-settings'||![1,2,3].includes(raw.version)||!raw.settings||typeof raw.settings!=='object'||Array.isArray(raw.settings))throw Error('不支持的设置文件或版本');
 const safeCurrent=current&&typeof current==='object'&&!Array.isArray(current)?current:{};
 const data=migrate(raw.settings,raw.version);
 for(const key of Object.keys(defaults))if(!(key in raw.settings)&&key in safeCurrent)data[key]=safeCurrent[key];
 data.key='key' in safeCurrent?safeCurrent.key:'';
 data.recognitionKey='recognitionKey' in safeCurrent?safeCurrent.recognitionKey:'';
 return validate(data);
}
module.exports={defaults,validate,createStore,exportText,importText};

