/** Expose the selected company models while retaining private route resolution. */
export function publicModelMetadata(metadata){
 if(metadata===undefined)return;
 const providers={};
 if(metadata.providers?.['deepseek-official'])providers['deepseek-official']=metadata.providers['deepseek-official'];
 const ark=metadata.providers?.['volcengine-ark'];
 if(ark){const models=ark.models.filter(model=>['glm-5.3-flash-260828','deepseek-v4-1-flash-261017'].includes(model.id));if(models.length)providers['volcengine-ark']={...ark,models};}
 const yunying=metadata.providers?.yunying;
 if(yunying){const allowed=new Set(['gpt-6.1-sol','gemini-3.1-pro']);const models=yunying.models.filter(model=>allowed.has(model.id));if(models.length)providers.yunying={...yunying,models};}
 const bailian=metadata.providers?.['alibaba-bailian'];
 if(bailian){const models=bailian.models.filter(model=>model.id==='deepseek-v4.1-flash-1017');if(models.length)providers['alibaba-bailian']={...bailian,models};}
 {const p=metadata.providers?.jubian;if(p?.models?.length)providers.jubian=p;}
 return {...metadata,providers};
}
