const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');const {setTimeout:delay}=require('node:timers/promises');const {validate,atomic}=require('./subtitles.cjs');
const RULE_VERSION='4.1.8',LOCAL_CACHE_SCHEMA=15;
const digest=x=>crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify({ruleVersion:RULE_VERSION,value:x})).digest('hex');
function endpoint(base){const u=new URL(base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('Base URL 无效（不能含凭据、查询或片段）');u.pathname=u.pathname.replace(/\/+$/,'');if(!u.pathname.endsWith('/chat/completions'))u.pathname+='/chat/completions';return u.toString()}
function chunks(cues,tokens){const limit=Math.max(400,Math.min(12000,Math.floor(tokens*.55)));let current=[],chars=0,out=[];for(const c of cues){if(current.length&&(current.length>=150||chars+c.text.length+32>limit)){out.push(current);current=[];chars=0}current.push(c);chars+=c.text.length+32}if(current.length)out.push(current);return out}
function refusalError(){const e=Error('接口拒绝翻译，本批未生成译文；请检查服务返回说明或更换适用的服务');e.code='TRANSLATION_REFUSAL';e.refusal=true;e.retry=true;return e}
function isRefusalText(value){const text=String(value||'').trim();return /(?:不能|无法|不可以|不支持|拒绝|不予)(?:为您|为你|帮您|帮你)?(?:提供|进行|协助)?(?:翻译|处理|生成|提供|回答|完成|协助)|(?:内容|请求).{0,30}(?:政策|敏感|违规|限制).{0,30}(?:拒绝|无法|不能)|Sorry[,\s]+|I(?:'m| am) sorry|I (?:cannot|can't|am unable to)\s/i.test(text)}
function sourceDiscussesTranslation(source){return /(?:翻訳|字幕|訳文|翻译|译文|翻譯|translation|subtitle)/iu.test(String(source||''))}
function translationMetaIssue(text,source=''){
 const value=String(text??'').trim();
 if(!value)return '空译文';
 if(/(?:<\/?think>|作为(?:一个)?(?:人工智能|语言模型)|我是.{0,8}(?:语言模型|人工智能)|只返回.{0,8}(?:译文|中文)|上一次输出|翻译结果如下|译文如下)/iu.test(value))return '模型说明或提示词回声';
 if(isRefusalText(value)){
  const supports=/(?:翻译|译文|字幕|translate)/iu.test(value)
   ?/(?:翻訳でき(?:ない|ません)|訳せ(?:ない|ません)|翻訳.{0,8}(?:無理|断る)|(?:不能|无法|不可以|不支持).{0,6}翻译|can(?:not|'t) translate)/iu.test(source)
   :/(?:できない|できません|答えられ(?:ない|ません)|無理|拒否|断る|不能|无法)/iu.test(source);
  if(!supports)return '与原声无关的拒答';
 }
 if(!sourceDiscussesTranslation(source)&&/(?:字幕|译文|翻译|翻譯)/u.test(value)&&/(?:请|详细|用心|保留|照原样|给我|拿出来|多谢|感谢|谢谢|哪个|应该|结果|如下)/u.test(value))return '与原声无关的翻译说明';
 if(/^(?:待复核|待处理|待审核|待校对|未完成|翻译失败|译文生成失败|需要人工.{0,4}(?:复核|校对))[。！!\s]*$/u.test(value)&&!sourceDiscussesTranslation(source))return '内部占位文本';
 return '';
}
function cloudQualityIssue(text,source,language='中文'){
 const value=String(text??'').trim(),meta=translationMetaIssue(value,source);if(meta)return meta;
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uFFFD]/u.test(value)||/\n\s*\n/u.test(value))return '乱码或非法分隔';
 if(language==='中文'&&(/[A-Za-zａ-ｚＡ-Ｚ\u3040-\u30ff]/u.test(value)||!/[\u3400-\u9fff]/u.test(value)))return '不是合格中文译文';
 return '';
}
function isPolicyRefusal(status,data,text){const value=[data?.message,data?.code,data?.error,data?.type,text].filter(Boolean).join(' ');return [400,403,422].includes(Number(status))&&/(?:content[_ -]?filter|content policy|safety|moderation|sensitive|内容策略|敏感内容|违规内容|内容不允许|不允许处理)/i.test(value)}
function sourceIsGarbled(text){
 const value=String(text??'').normalize('NFKC').replace(/[\s\u3000、，,。！？!?…~～]+/g,'').trim();
 if(!value)return false;
 if(/(?:ちゃん|さん|くん|様|君)$/u.test(value))return false;
 if(value.includes('�')||/[\uFFF0-\uFFFF]/u.test(value))return true;
 const latin=(value.match(/[A-Za-z]/g)||[]).length;
 const kana=(value.match(/[\u3040-\u30ff]/g)||[]).length;
 const han=(value.match(/[\u3400-\u9fff]/g)||[]).length;
 return latin>0&&!han&&value.length<=24&&(kana===0||(latin>=2&&kana<=3));
}
function localSourceAnomaly(text){
 const value=String(text??'').normalize('NFKC').replace(/[\s\u3000、，,。！？!?…~～]+/g,'').trim();
 if(!value)return '';
 const latin=(value.match(/[A-Za-z]/g)||[]).length;
 const kana=(value.match(/[\u3040-\u30ff]/g)||[]).length;
 const han=(value.match(/[\u3400-\u9fff]/g)||[]).length;
 if(kana||han||latin<12)return '';
 if(latin>=16||/([A-Za-z]{2,})\1{1,}/iu.test(value))return '长英文或乱码模板式识别结果';
 return '';
}
const SEXUAL_SOURCE_RULES=[
 {source:/(?:おっぱい|オッパイ|乳房)/u,target:'奶子',output:/(?:乳房|胸部|胸|乳|奶子)/gu},
 {source:/(?:まんこ|マンコ|膣|陰部)/u,target:'骚穴',output:/(?:阴部|陰部|阴道|私处|下体|小穴|骚穴)/gu},
 {source:/(?:ちんこ|チンコ|ちんぽ|チンポ|おちんちん|おちんぽ|ペニス|陰茎)/u,target:'鸡巴',output:/(?:阴茎|陰莖|生殖器|阳物|陽物|小弟弟|鸡巴)/gu}
];
function applySexualGlossary(source,text){
 let value=String(text??'').trim();
 for(const rule of SEXUAL_SOURCE_RULES){if(rule.source.test(String(source??''))&&!value.includes(rule.target))value=value.replace(rule.output,rule.target)}
 return value;
}
function sourceRuleTranslation(text){return localRuleTranslation(text)||localMoan(text)||(sourceIsGarbled(text)?'嗯♡':'')}
function cleanLocalTranslatedText(source,text,language='中文'){
 const forced=language==='中文'?sourceRuleTranslation(source):'';
 const translated=forced||text;
 return collapseLocalRepeated(language==='中文'?applySexualGlossary(source,translated):translated);
}
function cleanCloudTranslatedText(source,text){return String(text??'').trim()}
function decode(body,part,language='中文',{allowInvalid=false}={}){
 let response;try{response=JSON.parse(body)}catch{throw Error('接口响应不是有效 JSON，请检查服务地址与接口格式')}
 const choice=response?.choices?.[0];
 if(choice?.message?.refusal||choice?.finish_reason==='content_filter'){
  if(allowInvalid)return {good:[],bad:part.map(c=>({cue:c,reason:'接口拒绝翻译'}))};throw refusalError();
 }
 if(choice?.finish_reason==='length'){const e=Error('译文超出 max_tokens，已截断，请增大限制');e.truncated=true;throw e}
 let text=choice?.message?.content;if(typeof text!=='string')throw Error('接口未返回译文文本，请检查模型与聊天接口兼容性');
 text=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
 let payload;try{payload=JSON.parse(text)}catch{
  if(isRefusalText(text)){if(allowInvalid)return {good:[],bad:part.map(c=>({cue:c,reason:'接口拒绝翻译'}))};throw refusalError()}
  throw Error('接口未按要求返回字幕 JSON；请检查提示词或模型的格式支持');
 }
 const list=payload?.translations;if(!Array.isArray(list)||list.length!==part.length)throw Error('返回字幕条数不完整');
 const expected=new Set(part.map(c=>c.id)),map=new Map();
 for(const row of list){if(!row||!Number.isSafeInteger(row.id)||!expected.has(row.id)||map.has(row.id)||typeof row.text!=='string')throw Error('返回编号不对应、重复或文本类型无效');map.set(row.id,row.text.trim())}
 const good=[],bad=[];
 for(const cue of part){const text=cleanCloudTranslatedText(cue.text,map.get(cue.id)),reason=cloudQualityIssue(text,cue.text,language);if(reason)bad.push({cue,reason,text});else good.push({...cue,text})}
 if(allowInvalid)return {good,bad};
 if(bad.length)throw Object.assign(refusalError(),{invalid:bad});validate(good);return good;
}
async function translateCloud(cues,settings,options={}){return require('./cloud_translation.cjs').translateCloud(cues,settings,options)}
const SHORT_RULE_MAP=new Map([
 ['うん','嗯'],['うんうん','嗯嗯'],['ううん','嗯，不'],['はい','好'],['はいはい','好好'],['ええ','嗯'],['そう','是这样'],['そうそう','对，就是这样'],['やだ','不要'],['いや','不要'],['だめ','不行'],['ダメ','不行'],
 ['ねえ','喂'],['ねぇ','喂'],['うーん','嗯'],['うんー','嗯'],['んー','嗯'],['えー','呃'],['ええと','那个'],['ネチャン','姐姐'],['ねちゃん','姐姐'],['ネーチャン','姐姐'],['ねーちゃん','姐姐'],['姉ちゃん','姐姐'],['お姉ちゃん','姐姐'],['おっぱい','奶子'],['オッパイ','奶子'],['まんこ','骚穴'],['マンコ','骚穴'],['ちんこ','鸡巴'],['チンコ','鸡巴'],['おちんちん','鸡巴'],['おちんぽ','鸡巴'],['ペニス','鸡巴'],['ありがとう','谢谢'],['ごめん','对不起']
]);
const MOAN_MAP=new Map([['はぁはぁ','齁哦哦哦♡'],['はあはあ','齁哦哦哦♡'],['はぁ','齁噢'],['はあ','齁噢'],['ほう','哦齁齁♡'],['ほお','哦齁齁♡'],['うう','呜嗯♡'],['うぅ','呜嗯♡'],['ああ','啊♡'],['あぁ','啊♡'],['おう','吼哦'],['オー','吼哦'],['おー','吼哦'],['フフ','嗯♡'],['ふふ','嗯♡'],['ぶん','嗯♡'],['んっ','嗯♡'],['あっ','啊♡'],['あん','嗯啊']]);
const LOCAL_MOAN_TEMPLATES=['齁哦哦哦♡','齁噢','哦齁齁♡','吼哦','啊♡','嗯♡','嗯啊','呜嗯♡','啊嗯'];
function localMoanTemplatePollution(text,source){
 const original=String(source??'');if(localMoan(original)||sourceRuleTranslation(original))return '';
 const value=String(text??'');const hits=LOCAL_MOAN_TEMPLATES.filter((item,index)=>value.includes(item)&&LOCAL_MOAN_TEMPLATES.indexOf(item)===index);
 return hits.length>=2||hits.length===1&&value.length>Math.max(20,original.length*4+8)?'固定呻吟模板污染':'';
}
const LOCAL_NAME_GLOSSARY=[['ネチャン','姐姐'],['ねちゃん','姐姐'],['ネーチャン','姐姐'],['ねーちゃん','姐姐'],['姉ちゃん','姐姐'],['お姉ちゃん','姐姐']];
function normalizedShort(text){return String(text).normalize('NFKC').replace(/[\s　、，。！？!?.,…~～]+/g,'')}
function localRuleTranslation(text){const key=normalizedShort(text);if(SHORT_RULE_MAP.has(key))return SHORT_RULE_MAP.get(key);for(const [word,value]of SHORT_RULE_MAP){if(key.length>=word.length*2&&key.length%word.length===0&&word.repeat(key.length/word.length)===key)return value+'，'+value}return ''}
function localMoan(text){const key=normalizedShort(text);if(SHORT_RULE_MAP.has(key))return '';if(MOAN_MAP.has(key))return MOAN_MAP.get(key);if(/^(?:はぁ|はあ){2,}$/.test(key))return '齁哦哦哦♡';if(/^(?:ほう|ほお)+$/.test(key))return '哦齁齁♡';if(/^(?:うう|うぅ|うー|ふぅ|ふう)+$/.test(key))return '呜嗯♡';if(/^(?:ああ|あぁ)+$/.test(key))return '啊♡';if(/^(?:おう|おー|オー|おぉ|おお|うお)+$/.test(key))return '吼哦';if(/^(?:あーん|あんっ)+$/.test(key))return '嗯啊';if(/^(?:んー|んっ|ぅ)+$/.test(key))return '嗯♡';return ''}
function validLocalChinese(text){const value=String(text??'').trim();if(!value||/[\r\n]/.test(value)||/[A-Za-zａ-ｚＡ-Ｚぁ-ゖァ-ヺー]/.test(value)||value.includes('�')||/<\/?think>/i.test(value))return false;if(/[^\u3400-\u4dbf\u4e00-\u9fff0-9０-９，。！？、；：；“”‘’（）【】《》〈〉…—－\-·.♡♥\s]/.test(value))return false;return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(value)}
function isLocalRefusal(text){const value=String(text??'').trim();if(!value)return false;return /^(?:(?:抱歉|对不起|很抱歉)[，,。:：\s]*)?(?:我)?(?:不能|无法|不可以|不支持)(?:为您|帮您)?(?:翻译|处理|生成|提供|回答|完成)(?:这段|该|此)?(?:字幕|内容|请求|文本)?[。.!！\s]*$/i.test(value)||/^(?:抱歉|对不起|很抱歉)[，,。:：\s]+.*(?:不能|无法|不可以|不支持).*(?:翻译|处理|生成|提供|回答|请求)/i.test(value)}
function acceptableLocalChinese(text,source=''){return validLocalChinese(text)&&(!isLocalRefusal(text)||source&& !translationMetaIssue(text,source))}
function localMetaIssue(text,source=''){
 const value=String(text??'').trim();
 const general=translationMetaIssue(value,source);if(general)return general;
 if(!value)return '';
 if(/(?:心形符号|心形标志|爱心符号)(?:呢|哦|呀|哟)?[。.!！]?/.test(value))return '疑似符号解释文本';
 if(!sourceDiscussesTranslation(source)&&/(?:这|该|当前|下面)条字幕/.test(value))return '疑似提示词说明文本';
 if(!sourceDiscussesTranslation(source)&&/(?:将|把).{0,12}字幕.{0,12}(?:翻译|译成|转换)/.test(value))return '疑似提示词说明文本';
 if(/(?:自然的?中文译文|中文译文如下|只返回.{0,8}(?:译文|中文)|上一次输出|翻译结果)/.test(value))return '疑似提示词说明文本';
 if(/(?:谢谢|感谢)观看/.test(value)&&!/(?:視聴|观看|觀看)/u.test(source))return '疑似模板化片尾文本';
 return '';
}
const LOCAL_INTERNAL_MARKER=/(?:待复核|待处理|待审核|待校对|未完成|翻译失败|译文生成失败|需要人工(?:复核|审核|校对)|(?:请|建议)(?:重新翻译|重试)|最后一次(?:修正|纠错)|上一次输出|翻译结果如下|译文如下|只返回.{0,8}译文)/u;
function isLocalPlaceholder(text){return LOCAL_INTERNAL_MARKER.test(String(text??'').trim())}
function localQualityIssue(text,original){
 const value=String(text??'').trim(),source=String(original??'').trim();
 if(!value)return '空译文';
 if(isLocalPlaceholder(value))return '待复核占位文本';
 if(localMoanTemplatePollution(value,source))return '呻吟模板污染';
 if(hasTripleRepeatedPhrase(value))return '连续短语重复三次以上';
 const maxLength=Math.max(24,source.length*4+12);
 if(value.length>maxLength)return `译文异常扩长（${value.length}>${maxLength}）`;
 const sourceLength=normalizeContextKey(source).length,chineseLength=(value.match(/[\u3400-\u9fff]/gu)||[]).length;
 if(sourceLength>=12&&!sourceRuleTranslation(source)&&chineseLength<Math.max(3,Math.floor(sourceLength*.2)))return '完整原声被缩成过短回应';
 if(!localRuleTranslation(source)&&!localMoan(source)&&/^[\u3040-\u30ffー\s！？!?、，。~～]+$/u.test(source)&&source.replace(/[\s！？!?、，。~～]+/g,'').length<=8&&value.length>16)return '短日文字幕被扩写';
 const clauses=value.split(/[。！？!?，,]+/u).map(s=>s.trim()).filter(Boolean);
 const naturalRepeat=clauses.length===2&&clauses[0]===clauses[1]&&clauses[0].length<=8;
 const sourceClauses=source.split(/[。！？!?，,、]+/u).filter(s=>s.trim()).length;
 if(source.length<=8&&!naturalRepeat&&clauses.length>Math.max(2,sourceClauses)&&value.length>12)return '短字幕被扩写为多句';
 const meta=localMetaIssue(value,source);if(meta)return meta;
  const semantic=localSemanticDetachment(value,source);if(semantic)return semantic;
 if(/无法为您/.test(value)&&!sourceDiscussesTranslation(source))return '疑似复制提示词或说明文本';
 return '';
}
function localSemanticDetachment(text,source){
 const value=String(text??''),original=String(source??'');
 const checks=[
  [/(?:生日|生辰)/u,/(?:記念日|記念)/u,'原声“纪念日”被误译为生日'],
  [/(?:好球|账号|帐号)/u,/(?:おなほ|オナホ)/u,'原声“おなほ”被误译为无关词'],
  [/(?:看字幕|字幕拿出来|翻译说明)/u,/(?:コスコス|擦る|こする)/u,'原声动作被误译为字幕说明'],
  [/(?:鞋带|鞋子系带)/u,/(?:足のしきゅう|しきゅう)/u,'原声被误译为无关物品']
 ];
 return checks.some(([bad, evidence])=>bad.test(value)&&evidence.test(original))?'译文与原声语义脱离':'';
}
function sanitizeLocalCandidate(source,text){
 let value=String(text??'').replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```(?:text)?\s*/i,'').replace(/\s*```$/,'').trim();
 // Reject explanatory output as a whole; deleting a marker can leave invented dialogue.
 if(isLocalPlaceholder(value)||localMetaIssue(value,source)||isLocalRefusal(value)||localMoanTemplatePollution(value,source))return value;
 return cleanLocalTranslatedText(source,value,'中文');
}
function localText(body,source=''){let response;try{response=JSON.parse(body)}catch{const e=Error('本地模型响应不是有效 JSON');e.code='LOCAL_FORMAT';throw e}const choice=response?.choices?.[0];if(choice?.finish_reason==='length'){const e=Error('本地模型输出超出 max_tokens');e.code='LOCAL_FORMAT';e.truncated=true;throw e}if(choice?.message?.refusal||choice?.finish_reason==='content_filter')throw Object.assign(Error('本地模型拒绝翻译'),{code:'LOCAL_REFUSAL'});let text=choice?.message?.content;if(typeof text!=='string'){const e=Error('本地模型未返回译文');e.code='LOCAL_FORMAT';throw e}text=sanitizeLocalCandidate(source,text);if(!acceptableLocalChinese(text,source)){const e=Error('本地模型输出不是合格的纯中文译文');e.code=isLocalRefusal(text)?'LOCAL_REFUSAL':'LOCAL_OUTPUT';e.invalidText=text;throw e}return text}
function normalizeContextKey(text){return String(text??'').normalize('NFKC').replace(/[\s\u3000、，,。！？!?；;：:…~～“”‘’（）()【】\[\]]+/g,'').trim()}
function looksLikeNameCue(text){const value=normalizeContextKey(text);return value.length>=3&&value.length<=12&&/^[\u3040-\u30ff]+(?:くん|ちゃん|さん|さま|様|君)$/u.test(value)}
function createLocalContextCache(cues){
 const counts=new Map(),names=new Map(),letters={A:'阿',B:'比',C:'西',D:'迪',E:'伊',F:'艾弗',G:'吉',H:'艾奇',I:'艾',J:'杰',K:'凯',L:'艾尔',M:'艾姆',N:'恩',O:'欧',P:'皮',Q:'丘',R:'阿尔',S:'艾丝',T:'蒂',U:'优',V:'维',W:'达布',X:'艾克斯',Y:'歪',Z:'泽'};
 for(const cue of cues)for(const match of String(cue.text).normalize('NFKC').matchAll(/\b([A-Z]{1,4})(ちゃん|さん|くん|君)/gu))counts.set(match[0],(counts.get(match[0])||0)+1);
 for(const [name,count] of counts)if(count>=2){const latin=name.match(/^[A-Z]+/u)[0];names.set(name,[...latin].map(c=>letters[c]).join(''))}
 return {translations:new Map(),names,cues};
}
function rememberLocalContext(cache,cue,text){if(!cache||!cue||!text)return;cache.translations.set(cue.id,{source:String(cue.text||''),text:String(text)});if(looksLikeNameCue(cue.text)){const key=normalizeContextKey(cue.text);if(!cache.names.has(key))cache.names.set(key,String(text).replace(/[。！？!?，,]+$/,''))}}
function contextForPrompt(cache,index){
 if(!cache?.cues||!Number.isInteger(index))return '';
 const neighborhood=cache.cues.slice(Math.max(0,index-2),index+3).map(c=>c.text).join('\n');
 const names=[...(cache.names?.entries()||[])].filter(([source])=>neighborhood.includes(source)).slice(0,8);
 return names.length?'\n本片已确定称呼：'+names.map(([source,target])=>source+'译为'+target).join('，')+'。':'';
}
function localPrompt(settings,cue,attempt,invalidText='',context={}){
 const original=String(cue.text||''),cache=context.cache;
 const aliases=[...LOCAL_NAME_GLOSSARY,...(cache?.names?Array.from(cache.names.entries()):[])];
 const matched=aliases.filter(([source])=>original.includes(source)&&
  !aliases.some(([long])=>long!==source&&long.includes(source)&&original.includes(long)));
 const glossary=matched.length?'\n固定称呼：'+matched.map(([source,target])=>source+'译为'+target).join('，')+'。':'';
 const known=original.length<=6?'':contextForPrompt(cache,context.index);
 let input=original;for(const [source,target]of matched)input=input.split(source).join(target);
 const terms=SEXUAL_SOURCE_RULES.filter(rule=>rule.source.test(original)).map(rule=>rule.target);
 const vocabulary=terms.length?'\n保留原文语气，对应词汇使用：'+terms.join('、')+'。':'';
 const retry=attempt>1?'重新独立翻译当前这一句，不解释修正过程。':'';
 return '把当前日文字幕忠实翻译成简短自然的简体中文。只输出译文，不输出日文、英文、罗马字、解释或状态词。不要补写原文没有的情节。'+
  retry+glossary+known+vocabulary+'\n日文：'+input+'\n中文：';
}
const REPEAT_DELIMITER=/([\s\u3000,，、;；:：。！？!?…]+)/;
function repeatUnitKey(text){return String(text??'').normalize('NFKC').replace(/[\s\u3000,，、;；:：。！？!?…]+/g,'')}
function collapseCompactRepeated(text){
 const value=String(text??'').normalize('NFKC');
 if(value.length<3)return {text:value,changed:false};
 const maxUnit=Math.min(12,Math.floor(value.length/3));
 for(let size=1;size<=maxUnit;size++){
  if(value.length%size!==0)continue;
  const unit=value.slice(0,size),count=value.length/size;
  if(count>=3&&unit.repeat(count)===value)return {text:`${unit}，${unit}`,changed:true};
 }
 return {text:value,changed:false};
}
function collapseLocalRepeatedDetailed(text){
 let value=String(text??'').normalize('NFKC').replace(/\s+/g,' ').trim();
 if(!value)return {text:'',changed:false};
 const parts=value.split(REPEAT_DELIMITER),out=[];let changed=false;
 for(let i=0;i<parts.length;){
  if(i%2===0&&parts[i]){
   const token=parts[i];let j=i,count=1;
   while(j+2<parts.length&&parts[j+1]&&repeatUnitKey(parts[j+2])===repeatUnitKey(token)){count++;j+=2}
   if(count>=3){out.push(token,'，',token);changed=true;i=j+1;continue}
   const compact=collapseCompactRepeated(token);out.push(compact.text);changed ||= compact.changed;i++;continue;
  }
  out.push(parts[i]);i++;
 }
 return {text:normalizeLocalPunctuation(out.join('').replace(/\s+/g,' ').replace(/[，、;；:：]+$/,'').trim()),changed};
}
function normalizeLocalPunctuation(text){
 const symbols={',':'，','!':'！','?':'？',';':'；',':':'：','(':'（',')':'）','[':'【',']':'】'};
 return String(text??'').replace(/\.{3,}/g,'…').replace(/[,.!?;:()[\]]/g,(ch,offset,value)=>
  ch==='.'?( /\d/.test(value[offset-1]||'')&&/\d/.test(value[offset+1]||'')?'.':'。'):symbols[ch])
  .replace(/"([^"]*)"/g,'“$1”').replace(/'/g,'’').replace(/"/g,'”');
}
function collapseLocalRepeated(text){return collapseLocalRepeatedDetailed(text).text}
function hasTripleRepeatedPhrase(text){return collapseLocalRepeatedDetailed(text).changed}
function cleanTranslationCue(cue,failures,sourceText=''){
 const source=sourceText||cue.text;const normalized={...cue,text:cleanLocalTranslatedText(source,cue.text,'中文')};
 const cleaned=collapseLocalRepeatedDetailed(normalized.text);
 if(!cleaned.changed)return normalized;
 const output={...normalized,text:cleaned.text};
 return output;
}
function localFallbackText(cue,lastInvalid){
 const source=String(cue?.text||''),forced=sourceRuleTranslation(source);if(forced)return {text:forced,kind:'rule-mapped'};
 let candidate=sanitizeLocalCandidate(source,lastInvalid);candidate=collapseLocalRepeated(candidate);
 if(candidate&&acceptableLocalChinese(candidate,source)&&!localQualityIssue(candidate,source))return {text:candidate,kind:'rule-cleaned'};
 return {text:'',kind:'translation-dropped'};
}
async function recordLocalEvent(file,entry){if(!file)return;try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.appendFile(file,JSON.stringify(entry)+'\n','utf8')}catch{/* diagnostics must never mask the translation error */}}
const recordDiagnostic=recordLocalEvent;
const recordLocalFailure=recordLocalEvent;
function localModelsUrl(base){const u=new URL(base||'http://127.0.0.1:8092/v1');u.pathname=u.pathname.replace(/\/+$/,'')+'/models';u.search='';u.hash='';return u.toString()}
async function checkLocalService(settings,{signal,fetchImpl=fetch}={}){const controller=new AbortController();const abort=()=>controller.abort(signal?.reason);if(signal){if(signal.aborted)throw signal.reason||Error('任务已取消');signal.addEventListener('abort',abort,{once:true})}const timer=setTimeout(()=>controller.abort(),2000);try{const response=await fetchImpl(localModelsUrl(settings.localBaseurl),{method:'GET',redirect:'error',signal:controller.signal});if(!response||!response.ok)throw Error(`HTTP ${response?.status||'未知'}`);return true}catch(e){if(signal?.aborted)throw signal.reason||Error('任务已取消');throw Error('本地翻译服务不可用，请先启动 llama-server 并确认接口地址（'+(settings.localBaseurl||'http://127.0.0.1:8092/v1')+'）')}finally{clearTimeout(timer);if(signal)signal.removeEventListener('abort',abort)}}
async function modelCachePaths(modelPath){
 const current=path.resolve(String(modelPath||''));const name=path.basename(current);const out=[current];
 const modelsDir=path.dirname(current);const releaseDir=path.resolve(modelsDir,'..','..','..');
 try{for(const entry of await fs.readdir(releaseDir,{withFileTypes:true})){if(!entry.isDirectory())continue;const candidate=path.join(releaseDir,entry.name,path.basename(path.resolve(modelsDir,'..')), 'models', name);if(!out.includes(candidate))out.push(candidate)}}catch{}
 return out;
}
async function translateLocal(cues,settings,options={}){
 validate(cues);
 const {signal=new AbortController().signal,cacheDir,onProgress=()=>{},fetchImpl=fetch,
  cacheGeneration='',taskId='',sourceFingerprint='',recognitionMode='local',
  diagnosticFile='',recoverLocalService=async()=>{},cacheFiles=[]}=options;
 const retries=Number(settings.retries??2),url=endpoint(settings.localBaseurl||'http://127.0.0.1:8092/v1');
 if(!Number.isInteger(retries)||retries<0||retries>10)throw Error('自动重试次数必须为 0～10 的整数');
 if(!settings.localModelPath?.trim())throw Error('请先选择 Hy-MT2 GGUF 模型文件');
 signal.throwIfAborted();
 await fs.mkdir(cacheDir,{recursive:true});
 const sourceHash=sourceFingerprint||digest(cues);
 const namespace={taskId,sourceHash,recognitionMode,translationMode:'local',generation:cacheGeneration};
 const contextCache=createLocalContextCache(cues),result=[],failures=[],droppedIds=[];
 const record=entry=>recordLocalEvent(diagnosticFile,{time:new Date().toISOString(),mode:'local',ruleVersion:RULE_VERSION,...entry});
 await record({event:'translation-run',version:RULE_VERSION,cacheSchema:LOCAL_CACHE_SCHEMA,
   prompt:'local-prompt-v13',quality:'local-quality-v12',model:'Hy-MT2-1.8B-Q4_K_M',
  namespace,cues:cues.length});
 for(let i=0;i<cues.length;i++){
  signal.throwIfAborted();
  const cue=cues[i],context={cache:contextCache,index:i};
  const file=path.join(cacheDir,digest({schema:LOCAL_CACHE_SCHEMA,...namespace,
   model:path.resolve(settings.localModelPath),url,tokens:settings.tokens,cue,
   context:localPrompt(settings,cue,1,'',context)})+'.json');
  if(!cacheFiles.includes(file))cacheFiles.push(file);
   let output,found,lastInvalid='',fallbackKind='';
  const mapped=sourceRuleTranslation(cue.text);
  if(mapped){
   output={...cue,text:mapped};
    await record({event:'translation-rule-mapped',cue,output:mapped,terminalState:'success'});
   }else if(localSourceAnomaly(cue.text)){
    const reason=localSourceAnomaly(cue.text);
    droppedIds.push(cue.id);
    fallbackKind='source-anomaly-dropped';
    const failure={id:cue.id,time:cue.time,source:cue.text,kind:fallbackKind,message:reason,attempts:0};
    failures.push(failure);
    await record({event:'translation-source-anomaly',cue,reason,action:fallbackKind,terminalState:'omitted'});
    await record({event:'translation-omitted',cue,attempts:0,reason,action:fallbackKind,terminalState:'omitted'});
  }else{
   try{
    const value=JSON.parse(await fs.readFile(file,'utf8'));
    const text=sanitizeLocalCandidate(cue.text,value?.text);
    if(value?.id===cue.id&&value?.time===cue.time&&acceptableLocalChinese(text,cue.text)&&!localQualityIssue(text,cue.text)){
     found={...cue,text};
    }else await fs.rm(file,{force:true});
   }catch{}
   if(found){
    output=found;
    await record({event:'translation-cache-hit',cueId:cue.id,namespace,terminalState:'success'});
   }else for(let attempt=1;attempt<=retries+1;attempt++){
    signal.throwIfAborted();
    onProgress({event:'translation',mode:'local',batch:i+1,total:cues.length,attempt,maxAttempts:retries+1});
    const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort()},settings.timeout||120000);
    try{
     signal.throwIfAborted();
     let response,body;
     try{
      response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'Hy-MT2-1.8B-Q4_K_M',max_tokens:Math.min(Number(settings.tokens)||128,256),
       temperature:attempt===2?.55:attempt>=3?.1:.2,top_p:attempt===2?.85:.6,top_k:20,repeat_penalty:1.05,
       stream:false,cache_prompt:false,messages:[{role:'user',content:localPrompt(settings,cue,attempt,'',context)}]}),
       signal:controller.signal});
      body=await response.text();
     }catch(error){error.serviceFailure=true;throw error}
     if(!response.ok)throw Object.assign(Error('本地模型接口 HTTP '+response.status),{serviceFailure:true});
     let text=localTextWithNames(body,cue.text,contextCache),quality=localQualityIssue(text,cue.text);
     if(quality)throw Object.assign(Error(quality),{code:'LOCAL_QUALITY',invalidText:text});
     const raw=JSON.parse(body)?.choices?.[0]?.message?.content;
     if(raw!==text)await record({event:'translation-rule-cleaned',cue,original:raw,cleaned:text});
      output={...cue,text};
      await record({event:attempt>1?'translation-retry-success':'translation-success',cue,attempts:attempt,terminalState:'success'});
     break;
    }catch(error){
     signal.throwIfAborted();
     if(typeof error.invalidText==='string')lastInvalid=error.invalidText;
     const reason=timedOut?'请求超时':String(error.message||error);
     await record({event:'translation-attempt-failed',cue,attempt,maxAttempts:retries+1,
      reason,invalidOutput:error.invalidText||undefined});
     const serviceFailure=timedOut||error.serviceFailure||/fetch failed|network|socket|connection|ECONNREFUSED|ECONNRESET|EPIPE/i.test(reason);
     if(serviceFailure&&attempt<retries+1){
      try{await recoverLocalService({cue,index:i+1,attempt,error})}
      catch(recoveryError){signal.throwIfAborted();await record({event:'translation-service-recovery-failed',cueId:cue.id,message:String(recoveryError.message||recoveryError)})}
     }
     if(attempt===retries+1){
      if(serviceFailure){
       await record({event:'translation-service-unavailable',cue,attempts:attempt,
        reason,action:'preserve-source-and-resume'});
       throw Object.assign(Error('本机翻译服务异常，原声和断点已保留：'+reason),
        {code:'LOCAL_SERVICE_UNAVAILABLE',cueId:cue.id});
      }
      const fallback=localFallbackText(cue,lastInvalid);
      fallbackKind=fallback.kind;
      if(fallback.text)output={...cue,text:fallback.text};
      else droppedIds.push(cue.id);
      const failure={id:cue.id,time:cue.time,source:cue.text,kind:fallback.kind,message:reason,attempts:attempt};
      failures.push(failure);
       await record({event:'translation-failure',cue,attempts:attempt,message:reason,
        invalidOutput:lastInvalid||undefined,action:fallback.kind,output:fallback.text||undefined,
        terminalState:fallback.text?'success':'omitted'});
      onProgress({event:'translation-warning',mode:'local',batch:i+1,total:cues.length,kind:fallback.kind,message:reason});
     }else await delay(400*attempt,undefined,{signal});
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort)}
   }
  }
  if(output){
   const text=sanitizeLocalCandidate(cue.text,output.text);
   if(!acceptableLocalChinese(text,cue.text)||localQualityIssue(text,cue.text)){
    droppedIds.push(cue.id);
    failures.push({id:cue.id,time:cue.time,source:cue.text,kind:'translation-dropped',message:'最终质量闸门未通过'});
    await record({event:'translation-final-gate',cue,action:'translation-dropped',output:output.text});
    await fs.rm(file,{force:true});
   }else{
    output={...cue,text};
    signal.throwIfAborted();
    await atomic(file,output);
    rememberLocalContext(contextCache,cue,text);
    result.push(output);
   }
  }
  onProgress({event:'translation',mode:'local',batch:i+1,total:cues.length,cached:!!found,rule:!!mapped,
   dropped:!output||fallbackKind==='translation-dropped',completed:true});
 }
 validate(result,{allowEmpty:true});
 result.failures=failures;result.droppedIds=[...new Set(droppedIds)];
  await record({event:'translation-complete',version:RULE_VERSION,inputCues:cues.length,cues:result.length,
   dropped:result.droppedIds.length,fallbacks:failures.length,terminalState:result.droppedIds.length?'completed-with-omissions':'completed'});
 return result;
}
async function translate(cues,settings,options){return settings.translationMode==='local'?translateLocal(cues,settings,options):translateCloud(cues,settings,options)}
function localTextWithNames(body,source,cache){
 let response;try{response=JSON.parse(body)}catch{return localText(body,source)}
 const message=response?.choices?.[0]?.message;
 if(typeof message?.content==='string')for(const [name,target]of cache.names){
  if(!source.includes(name))continue;const latin=name.match(/^[A-Z]+/u)?.[0];
  if(latin)message.content=message.content.replace(new RegExp('\\b'+latin+'\\b','g'),target);
 }
 return localText(JSON.stringify(response),source);
}
module.exports={translate,translateCloud,translateLocal,checkLocalService,endpoint,chunks,decode,digest,validLocalChinese,isLocalRefusal,acceptableLocalChinese,localRuleTranslation,localMoan,sourceRuleTranslation,sourceIsGarbled,localSourceAnomaly,applySexualGlossary,cleanTranslatedText:cleanLocalTranslatedText,localMetaIssue,localSemanticDetachment,isLocalPlaceholder,localQualityIssue,sanitizeLocalCandidate,localPrompt,createLocalContextCache,rememberLocalContext,contextForPrompt,collapseLocalRepeated,hasTripleRepeatedPhrase,localFallbackText,cloudQualityIssue,isPolicyRefusal,translationMetaIssue};

