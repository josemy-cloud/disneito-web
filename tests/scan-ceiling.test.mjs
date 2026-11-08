import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeCeiling} from '../disenador-web/scan-core.mjs';
const width=256,height=144;
function image(withEdge){
 const pixels=new Uint8ClampedArray(width*height*4);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const seam=x<64?25-(64-x)*.49:x>190?30-(x-190)*.55:25+(x-64)*5/126;
  const tone=withEdge&&y>=seam?218:147;
  pixels.set([tone,tone,tone,255],(y*width+x)*4);
 }
 return {pixels,width,height};
}
test('encuentra una unión larga de techo sin un perímetro visible de suelo',()=>{
 const result=proposeCeiling(image(true));
 assert(result&&result.sides.length===2);
 assert(result.back[1][0]-result.back[0][0]>.3);
 assert(result.back.every(([,y])=>y>.13&&y<.25));
});
test('no inventa una pared si la vista no tiene borde',()=>{
 assert.equal(proposeCeiling(image(false)),null);
});

