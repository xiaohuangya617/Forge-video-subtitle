(function(root){
  function toMilliseconds(value){
    const match=String(value).trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
    if(!match)throw Error('请求超时请填写 1～3600 秒，最多三位小数');
    const ms=Number(match[1])*1000+Number((match[2]||'').padEnd(3,'0'));
    if(!Number.isSafeInteger(ms)||ms<1000||ms>3600000)throw Error('请求超时必须在 1～3600 秒之间');
    return ms;
  }
  if(typeof module==='object'&&module.exports)module.exports={toMilliseconds};
  else root.FactoryUnits={toMilliseconds};
})(globalThis);
