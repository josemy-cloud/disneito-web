import {analyseFrame,suggestReference} from './scan-core.mjs';

self.onmessage=({data})=>{
  const {id,pixels,width,height,source,target,points}=data;
  const result=source?suggestReference(source,target,points):analyseFrame(pixels,width,height);
  self.postMessage({id,result});
};

