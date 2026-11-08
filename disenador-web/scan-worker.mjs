import {analyseFrame,suggestReference,proposeFloor} from './scan-core.mjs';

self.onmessage=({data})=>{
  const {id,pixels,width,height,source,target,points,floor}=data;
  const result=floor?proposeFloor(data):source?suggestReference(source,target,points):analyseFrame(pixels,width,height);
  self.postMessage({id,result});
};


