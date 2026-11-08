import {analyseFrame,suggestReference,proposeFloor,proposeCeiling} from './scan-core.mjs';

self.onmessage=({data})=>{
  const {id,pixels,width,height,source,target,points,floor,ceiling}=data;
  const result=ceiling?proposeCeiling(data):floor?proposeFloor(data):source?suggestReference(source,target,points):analyseFrame(pixels,width,height);
  self.postMessage({id,result});
};



