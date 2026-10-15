const fs=require('node:fs/promises'),path=require('node:path');
function ms(s){const m=String(s).match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/);if(!m)throw Error('时间格式无效：'+s);return ((+m[1]*60 + +m[2])*60 + +m[3])*1000 + +m[4]}
function validate(cues,{allowEmpty=false}={}){if(!Array.isArray(cues)||(!cues.length&&!allowEmpty))throw Error('没有有效字幕');let previous=-1;const ids=new Set();for(let i=0;i<cues.length;i++){const c=cues[i];if(!Number.isSafeInteger(c.id)||c.id<1||ids.has(c.id))throw Error(`第 ${i+1} 条编号无效或重复`);ids.add(c.id);const parts=String(c.time).split(/\s*-->\s*/);if(parts.length!==2)throw Error(`第 ${i+1} 条时间轴无效`);const a=ms(parts[0]),b=ms(parts[1]);if(a>=b||a<previous)throw Error(`第 ${i+1} 条时间轴倒置或重叠`);previous=b;if(typeof c.text!=='string'||!c.text.trim()||/\n\s*\n/.test(c.text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c.text))throw Error(`第 ${i+1} 条内容为空或含非法分隔`)}return cues}
function parse(text,options){text=String(text).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();const cues=text?text.split(/\n[ \t]*\n/).map((b,i)=>{const lines=b.trim().split('\n');if(!/^\d+$/.test(lines[0])||lines.length<3)throw Error(`第 ${i+1} 条 SRT 结构无效`);return {id:Number(lines[0]),time:lines[1].trim().replace(/\./g,',').replace(/\s*-->\s*/,' --> '),text:lines.slice(2).join('\n').trim()}}):[];return validate(cues,options)}
function build(cues,options){validate(cues,options);return cues.map((c,i)=>`${c.id}\n${c.time}\n${c.text.trim()}\n`).join('\n')}
async function read(file,options){const bytes=await fs.readFile(file);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('字幕不是有效 UTF-8，请转换编码后再导入')}return parse(text,options)}
function pair(source,translated,{allowMissing=false,byTime=false}={}){
 validate(source,{allowEmpty:allowMissing});validate(translated,{allowEmpty:allowMissing});
 if(!allowMissing&&source.length!==translated.length)throw Error('原声与译文条数不一致');
 if(!allowMissing&&!byTime)return source.map((c,i)=>{const t=translated[i];if(c.id!==t.id||c.time!==t.time)throw Error(`第 ${i+1} 条原文与译文编号或时间轴不对应`);return {...t,original:c.text}});
 const timeKey=cue=>String(cue.time).split(/\s*-->\s*/).map(ms).join(':');
 const originals=new Set(source.map(timeKey)),translations=new Map();
 for(const cue of translated){const key=timeKey(cue);if(!originals.has(key))throw Error('译文时间轴没有对应原声');translations.set(key,cue)}
 return source.map(c=>({...(translations.get(timeKey(c))||{text:''}),id:c.id,time:c.time,original:c.text}));
}
function validateEdits(source,cues){
 validate(source);
 if(!Array.isArray(cues)||cues.length!==source.length)throw Error('校对字幕条数不一致');
 for(let i=0;i<cues.length;i++)if(!cues[i]||cues[i].id!==source[i].id||cues[i].time!==source[i].time||typeof cues[i].text!=='string')throw Error('校对字幕编号或时间轴不对应');
 return cues;
}
function safeName(s){return String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'')||'字幕'}
async function reserve(dir,name){await fs.access(dir);const p=path.parse(safeName(name));for(let i=1;i<10000;i++){const file=path.join(dir,p.name+(i===1?'':` (${i})`)+p.ext);try{const h=await fs.open(file,'wx');await h.close();return file}catch(e){if(e.code!=='EEXIST')throw e}}throw Error('无法分配输出路径')}
async function reservePath(dir,name){await fs.access(dir);const p=path.parse(safeName(name));for(let i=1;i<10000;i++){const file=path.join(dir,p.name+(i===1?'':` (${i})`)+p.ext);try{await fs.access(file)}catch(e){if(e.code==='ENOENT')return file;throw e}}throw Error('无法分配输出路径')}
async function save(dir,name,cues){const text=build(cues),file=await reserve(dir,name);try{await fs.writeFile(file,text,'utf8');const result=await read(file);pair(parse(text),result);return file}catch(e){await fs.unlink(file).catch(()=>{});throw e}}
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),'utf8');await fs.rename(tmp,file)}
async function writeAtomicText(file,text){const tmp=file+'.'+require('node:crypto').randomUUID()+'.tmp';try{await fs.writeFile(tmp,text,'utf8');await fs.rename(tmp,file)}finally{await fs.rm(tmp,{force:true}).catch(()=>{})}}
function normalizeRepeated(text){return String(text??'').normalize('NFKC').replace(/[\u3000\s]+/g,' ').replace(/[，。！？；：、]/g,m=>({',':',','，':',','。':'.','！':'!','？':'?','；':';','：':':','、':','}[m]||m)).trim()}
function cleanRepeated(cues,{minRun=3}={}){validate(cues,{allowEmpty:true});if(!Number.isInteger(minRun)||minRun<2)throw Error('重复清理阈值必须是大于等于 2 的整数');const kept=[],removed=[],groups=[];for(let i=0;i<cues.length;){let j=i+1,key=normalizeRepeated(cues[i].text);while(j<cues.length&&normalizeRepeated(cues[j].text)===key)j++;const count=j-i;if(key&&count>=minRun){kept.push(cues[i]);removed.push(...cues.slice(i+1,j));groups.push({start:cues[i].id,end:cues[j-1].id,count,text:cues[i].text})}else kept.push(...cues.slice(i,j));i=j}return {cues:kept,removed,groups,removedCount:removed.length,originalCount:cues.length,cleanedCount:kept.length}}
function cleanRepeatedPair(source,translated,{minRun=3}={}){if(source.length!==translated.length)throw Error('原声与译文条数不一致');const remove=new Set(),groups=[];for(let i=0;i<source.length;){const sourceKey=normalizeRepeated(source[i].text),translatedKey=normalizeRepeated(translated[i].text);let sourceEnd=i+1,translatedEnd=i+1;while(sourceEnd<source.length&&normalizeRepeated(source[sourceEnd].text)===sourceKey)sourceEnd++;while(translatedEnd<translated.length&&normalizeRepeated(translated[translatedEnd].text)===translatedKey)translatedEnd++;const end=sourceEnd-i>=minRun?sourceEnd:translatedEnd-i>=minRun?translatedEnd:i+1;if(end>i+1&&sourceKey||end>i+1&&translatedKey){for(let n=i+1;n<end;n++)remove.add(n);groups.push({start:source[i].id,end:source[end-1].id,count:end-i,original:source[i].text,translation:translated[i].text})}i=Math.max(sourceEnd,translatedEnd,end)}return {source:source.filter((_,i)=>!remove.has(i)),translated:translated.filter((_,i)=>!remove.has(i)),groups,removedCount:remove.size,originalCount:source.length,cleanedCount:source.length-remove.size}}
function repeatTokenKey(text){return String(text??'').normalize('NFKC').replace(/[\s\u3000,，、;；:：。！？!?…~～]+/g,'')}
function collapseCompactRepeated(text,{minRun=3,maxKeep=2}={}){
 const value=String(text??'').normalize('NFKC');
 if(value.length<minRun*2)return {text:value,changed:false,removed:0,repeatCount:1,unit:''};
 const maxUnit=Math.min(24,Math.floor(value.length/minRun));
 for(let size=1;size<=maxUnit;size++){
  if(value.length%size)continue;
  const unit=value.slice(0,size),count=value.length/size;
  if(count>=minRun&&unit.repeat(count)===value){const kept=Math.min(maxKeep,count);return {text:Array(kept).fill(unit).join('，'),changed:true,removed:value.length-unit.length*kept,repeatCount:count,unit}}
 }
 // 识别模型有时会把重复短语的首字切掉或粘连，例如“めだめだめ…”、“いじょうぶだいじょうぶ…”。
 // 只有当前缀正好是重复单元的尾部时才收束，避免误删正常长句。
 for(let offset=1;offset<=Math.min(12,value.length-2);offset++){
  const prefix=value.slice(0,offset),tail=value.slice(offset);
  for(let size=2;size<=Math.min(24,Math.floor(tail.length/Math.max(2,minRun-1)));size++){
   const unit=tail.slice(0,size);if(unit.slice(-offset)!==prefix)continue;
   if(tail.length%size)continue;const count=tail.length/size;
   if(count>=minRun-1&&unit.repeat(count)===tail){const kept=Math.min(maxKeep,count);return {text:Array(kept).fill(unit).join('，'),changed:true,removed:value.length-unit.length*kept,repeatCount:count+1,unit}}
  }
 }
 return {text:value,changed:false,removed:0,repeatCount:1,unit:''};
}
function collapseInternalRepeated(text,{minRun=3,maxKeep=2}={}){
 let value=String(text??'').normalize('NFKC').replace(/\s+/g,' ').trim();
 if(!value)return {text:'',changed:false,removed:0,groups:[],maxRepeat:1};
 const delimiter=/([\s\u3000,，、;；:：。！？!?…~～]+)/;
 const parts=value.split(delimiter),out=[],groups=[];let changed=false,removed=0,maxRepeat=1;
 for(let i=0;i<parts.length;){
  if(i%2===0&&parts[i]){
   const token=parts[i];let j=i,count=1;
   while(j+2<parts.length&&parts[j+1]&&repeatTokenKey(parts[j+2])===repeatTokenKey(token)){count++;j+=2}
   if(count>=minRun){const keep=Math.min(maxKeep,count);out.push(Array(keep).fill(token).join('，'));changed=true;removed+=Math.max(0,count-keep)*token.length;groups.push({unit:token,count,kept:keep});maxRepeat=Math.max(maxRepeat,count);i=j+1;continue}
   const compact=collapseCompactRepeated(token,{minRun,maxKeep});out.push(compact.text);if(compact.changed){changed=true;removed+=compact.removed;groups.push({unit:compact.unit,count:compact.repeatCount,kept:maxKeep});maxRepeat=Math.max(maxRepeat,compact.repeatCount)}i++;continue;
  }
  out.push(parts[i]);i++;
 }
 const result=out.join('').replace(/,{2,}/g,'，').replace(/\s+/g,' ').replace(/[，、;；:：]+$/,'').trim();
 return {text:result,changed,removed,groups,maxRepeat};
}
function cleanCloudTranslationText(text,{minRun=3,maxKeep=2}={}){
 const result=collapseInternalRepeated(text,{minRun,maxKeep});
 if(!result.changed)return {...result,text:String(text??'').trim()};
 return {...result,text:result.text.replace(/,/g,'，')};
}
function recognitionNoiseReason(text){
 const value=String(text??'').normalize('NFKC').replace(/[\s\u3000]+/g,'').trim();
 if(!value)return '空结果';
 if(/^(?:笑い声|笑声|笑聲|笑い|喘ぎ声|喘息声|呻吟|呻吟声|吐息|息遣い|呼吸音|拍手|音楽|音乐|laughter|laughing|sighs|sighing|moaning|music)$/iu.test(value))return '声音描述，不作为对白';
 if(/^[\p{P}\p{S}]+$/u.test(value))return '无意义符号';
 return '';
}
const LOCAL_SHORT_KEEP=new Set(['はい','うん','ううん','ねえ','ねぇ','ありがとう','ごめん','やだ','いや','だめ','ダメ','えっ','ええ','そう']);
const SOUND_UNITS=new Map([['う','うう'],['お','おう'],['あ','ああ'],['ふ','ふふ'],['うお','おう'],['おう','おう'],['おー','おう'],['オー','おう'],['はぁ','はぁ'],['はあ','はぁ'],['ほう','ほう'],['ほお','ほう'],['うう','うう'],['うぅ','うう'],['ふぅ','うう'],['ふう','うう'],['ああ','ああ'],['あぁ','ああ'],['ふふ','ふふ'],['フフ','ふふ'],['んっ','んっ'],['あっ','あっ'],['あん','あん']]);
function localVocalization(text){
 const value=String(text??'').normalize('NFKC').replace(/[\s\u3000。、，！？!?…~～]+/g,'').trim();
 if(!value||/[\u3400-\u9fffA-Za-zＡ-Ｚａ-ｚ]/u.test(value))return null;
 if(/^[ぁぃぅぇぉゃゅょゎ]/u.test(value))return null;
 if(SOUND_UNITS.has(value)&&value.length>1)return {unit:SOUND_UNITS.get(value),count:1};
 for(let size=1;size<=Math.min(4,Math.floor(value.length/2));size++){
  if(value.length%size)continue;
  const unit=value.slice(0,size),count=value.length/size;
  if(count>=2&&unit.repeat(count)===value&&SOUND_UNITS.has(unit))return {unit:SOUND_UNITS.get(unit),count};
 }
 const compact=value.replace(/[!?！？]/g,'');
 if(compact.length>=4&&/^[うおあふぁぅぉー]+$/u.test(compact)){const chars=[...compact],counts=new Map(chars.map(ch=>[ch,0]));for(const ch of chars)counts.set(ch,counts.get(ch)+1);const dominant=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0];if(dominant[1]/chars.length>=.7&&SOUND_UNITS.has(dominant[0]))return {unit:SOUND_UNITS.get(dominant[0]),count:dominant[1]};}
 return null;
}
function localWeakFragmentReason(text){
 const value=String(text??'').normalize('NFKC').replace(/[\s\u3000。、，！？!?…~～]+/g,'').trim();
 if(!value||LOCAL_SHORT_KEEP.has(value))return '';
 for(const word of LOCAL_SHORT_KEEP)if(value.length%word.length===0&&word.repeat(value.length/word.length)===value)return '';
 if(localVocalization(value))return '';
 if(/(?:待复核|待处理|未完成)/u.test(value)||value.includes('�'))return '本机无效文本或内部状态';
 if(!/[\u3400-\u9fff]/u.test(value)&&(/(.)\1{5,}/u.test(value)||/(.{1,3})\1{4,}/u.test(value)))return '本机非语义循环或异常字符序列';
 if(!/[\u3400-\u9fff]/u.test(value)&&/(.{2,3})\1{2,}/u.test(value)&&!/^(.{2,12})\1{2,}$/u.test(value))return '本机局部音节循环，无法确认完整语义';
 if(/^[ぁぃぅぇぉゃゅょゎ]/u.test(value))return '本机片段以小假名开头，疑似截断或模型碎片';
 if(value.length<=2&&/^[\u3040-\u30ffー]+$/u.test(value)&&!/(?:はぁ|はあ|ほう|ほお|うう|うぅ|ああ|あぁ|おう|おー|オー|ふふ|フフ|ぶん|んっ|あっ|あん)/u.test(value))return '本机孤立短片段，无稳定语义锚点';
 return '';
}
function cleanRecognitionCues(cues,{mode='local',minRun=3,maxKeep=2}={}){
 validate(cues,{allowEmpty:true});
 if(mode==='cloud'){
  const noiseRemoved=[],mapped=[];
  for(const cue of cues){const reason=recognitionNoiseReason(cue.text);if(reason){noiseRemoved.push({id:cue.id,time:cue.time,original:cue.text,reason});continue}mapped.push(cue)}
  const adjacent=cleanRepeated(mapped,{minRun});
  return {mode, cues:adjacent.cues,changes:[],anomalies:[],noiseRemoved,adjacent,weakRemoved:[],changed:noiseRemoved.length>0||adjacent.removedCount>0,originalCount:cues.length,cleanedCount:adjacent.cleanedCount,removedCount:0,noiseRemovedCount:noiseRemoved.length,adjacentRemovedCount:adjacent.removedCount,weakRemovedCount:0,reviewCount:0,abnormalCount:0};
 }
 const changes=[],anomalies=[],noiseRemoved=[],weakRemoved=[];const mapped=[];
 for(const cue of cues){
  const noiseReason=recognitionNoiseReason(cue.text);
  if(noiseReason){noiseRemoved.push({id:cue.id,time:cue.time,original:cue.text,reason:noiseReason});continue}
   const weakReason=localWeakFragmentReason(cue.text);
   if(weakReason){weakRemoved.push({id:cue.id,time:cue.time,original:cue.text,reason:weakReason});continue}
  const vocal=localVocalization(cue.text);
  if(vocal){
   const normalized={...cue,text:vocal.unit};
   changes.push({id:cue.id,time:cue.time,original:cue.text,cleaned:vocal.unit,groups:[{unit:vocal.unit,count:vocal.count,kept:1}],maxRepeat:vocal.count,removedChars:Math.max(0,String(cue.text||'').length-vocal.unit.length),kind:'vocalization-normalize'});
   const previous=mapped[mapped.length-1],previousSound=previous&&localVocalization(previous.text);
   const [start,end]=cue.time.split(/\s*-->\s*/);
   const gap=previous?ms(start)-ms(previous.time.split(/\s*-->\s*/)[1]):Infinity;
   if(previousSound?.unit===vocal.unit&&gap<=800&&gap>=0){
    changes.push({id:cue.id,time:cue.time,original:cue.text,kind:'vocalization-merge',mergedInto:previous.id,gapMs:gap,removedChars:0});
    previous.time=previous.time.split(/\s*-->\s*/)[0]+' --> '+end;
   }else mapped.push(normalized);
   continue;
  }
  const cleaned=collapseInternalRepeated(cue.text,{minRun,maxKeep});
  if(cleaned.changed){changes.push({id:cue.id,time:cue.time,original:cue.text,cleaned:cleaned.text,groups:cleaned.groups,maxRepeat:cleaned.maxRepeat,removedChars:cleaned.removed});mapped.push({...cue,text:cleaned.text});continue}
  if(String(cue.text||'').length>120)anomalies.push({id:cue.id,time:cue.time,original:cue.text,reason:'异常长字幕，保留清理后文本供复核'});
  mapped.push(cue);
 }
 const adjacent=cleanRepeated(mapped,{minRun});
  return {mode,cues:adjacent.cues,changes,anomalies,noiseRemoved,weakRemoved,adjacent,changed:changes.length>0||noiseRemoved.length>0||weakRemoved.length>0||adjacent.removedCount>0,originalCount:cues.length,cleanedCount:adjacent.cleanedCount,removedCount:changes.length?changes.reduce((n,x)=>n+(x.removedChars||0),0):0,noiseRemovedCount:noiseRemoved.length,weakRemovedCount:weakRemoved.length,adjacentRemovedCount:adjacent.removedCount,reviewCount:anomalies.length,abnormalCount:anomalies.length};
}
function renumber(cues){validate(cues,{allowEmpty:true});return cues.map((c,i)=>({...c,id:i+1}));}
function cleanTranslationRepeats(cues,{source=[],maxGapMs=1500}={}){
 validate(cues,{allowEmpty:true});const positions=new Map(source.map((cue,i)=>[cue.id,i])),kept=[],removed=[],groups=[];
 for(let i=0;i<cues.length;){let j=i+1;
  while(j<cues.length){const previous=cues[j-1],next=cues[j],gap=ms(next.time.split('-->')[0].trim())-ms(previous.time.split('-->')[1].trim());
   const adjacent=positions.size?positions.get(next.id)===positions.get(previous.id)+1:next.id===previous.id+1;
   if(!adjacent||gap<0||gap>maxGapMs||normalizeRepeated(next.text)!==normalizeRepeated(cues[i].text))break;j++;
  }
  if(j-i>=3){kept.push(cues[i]);removed.push(...cues.slice(i+1,j));groups.push({firstId:cues[i].id,ids:cues.slice(i+1,j).map(c=>c.id),text:cues[i].text,maxGapMs})}
  else kept.push(...cues.slice(i,j));i=j;
 }
 return {cues:kept,removed,groups};
}
async function appendJsonl(file,entries){if(!file||!entries?.length)return;await fs.mkdir(path.dirname(file),{recursive:true});await fs.appendFile(file,entries.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8')}
module.exports={ms,validate,parse,build,read,pair,validateEdits,safeName,reserve,reservePath,save,atomic,writeAtomicText,normalizeRepeated,cleanRepeated,cleanRepeatedPair,collapseInternalRepeated,cleanCloudTranslationText,cleanRecognitionCues,localVocalization,localWeakFragmentReason,renumber,appendJsonl,cleanTranslationRepeats};
