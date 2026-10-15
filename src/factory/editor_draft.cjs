const fs=require('node:fs/promises');
const sub=require('./subtitles.cjs');

function validateDraft(data){
 if(!data||data.format!=='subtitle-factory-editor-draft'||data.version!==1||
  typeof data.name!=='string'||!data.name||!Array.isArray(data.cues))throw Error('校对草稿格式无效');
 sub.validateEdits(data.reference,data.cues);
 return data;
}

function createDraftStore(file){
 let writes=Promise.resolve();
 return {
  save(data){
   const snapshot=data===null?null:structuredClone(validateDraft(data));
   writes=writes.catch(()=>{}).then(()=>snapshot===null?fs.rm(file,{force:true}):sub.atomic(file,snapshot));
   return writes;
  },
  async load(){
   await writes;
   try{return validateDraft(JSON.parse(await fs.readFile(file,'utf8')))}
   catch(error){if(error.code==='ENOENT')return null;throw Error('校对草稿无法读取，原文件已保留：'+error.message)}
  },
  flush:()=>writes
 };
}

module.exports={createDraftStore,validateDraft};
