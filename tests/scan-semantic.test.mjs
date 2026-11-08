import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticRoomGuides,preferSemanticCeiling} from '../disenador-web/scan-core.mjs';
test('descarta candidatos recortados y conserva una ventana interior',()=>{
 const width=128,height=128,labels=new Uint8Array(width*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  let label=y<29?5:0;
  if(y>=42&&y<=73&&(x>=24&&x<=50||x>=114))label=8;
  labels[y*width+x]=label;
 }
 const r=semanticRoomGuides({labels,width,height},1600,900);
 assert(r.ceiling);assert.equal(r.boxes.length,1);assert.equal(r.boxes[0].label,'Posible ventana');
});
test('una guía semántica corta o torcida no reemplaza la visual',()=>{
 const visual={back:[[.25,.14],[.75,.17]],sides:[]};
 const bad={back:[[.19,.12],[.51,.19]],sides:[]};
 const good={back:[[.26,.14],[.73,.17]],sides:[]};
 assert.equal(preferSemanticCeiling(bad,visual),visual);
 assert.equal(preferSemanticCeiling(good,visual),good);
});


