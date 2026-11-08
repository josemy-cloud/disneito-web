import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeFloor,estimateRoomAspect,validate,within} from '../disenador-web/scan-core.mjs';
const width=192,height=144;
function fixture(points,{dark=false,noisy=false,opening=false,tiles=false}={}){
 const pixels=new Uint8ClampedArray(width*height*4);
 const inside=(x,y)=>within([x,y],points);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const floor=inside(x,y),n=noisy?((x*47+y*71)%11)-5:0;
  const joint=tiles&&(x%17===0||y%19===0);
  const rgb=dark?[15,12,10]:floor?(joint?[96,87,72]:[152+n,116+n,83+n]):opening&&x>80&&x<110?[52,56,65]:[205,213,224];
  pixels.set([...rgb,255],(y*width+x)*4);
 }
 return {width,height,pixels};
}
const q=[[23,124],[48,63],[142,55],[172,116]];
test('propone cuatro esquinas a partir de píxeles y destaca la arista cercana',()=>{
 const candidate=proposeFloor(fixture(q,{noisy:true,opening:true}));
 assert(candidate);
 const points=candidate.points.map(([x,y])=>[x*width,y*height]);
 for(const [i,p] of [q[0],q[3],q[2],q[1]].entries())assert(Math.hypot(points[i][0]-p[0],points[i][1]-p[1])<=5);
});
test('rechaza suelo cortado, oscuridad, paredes sin suelo y una forma irregular',()=>{
 assert.equal(proposeFloor(fixture([[0,144],[36,63],[146,53],[192,125]])),null);
 assert.equal(proposeFloor(fixture(q,{dark:true})),null);
 assert.equal(proposeFloor(fixture([])),null);
 assert.equal(proposeFloor(fixture([[25,124],[41,58],[111,51],[112,80],[160,81],[171,125]])),null);
});
test('une baldosas separadas por juntas finas sin inventar un borde exterior',()=>{
 assert(proposeFloor(fixture(q,{tiles:true})));
 assert.equal(proposeFloor(fixture([[0,144],[36,63],[146,53],[192,125]],{tiles:true})),null);
});
test('estima proporción con una cámara oblicua y rechaza un frontal ambiguo',()=>{
 const camera={f:118,cx:96,cy:72};
 const u=[.8,.3,Math.sqrt(.27)],raw=[-.6,.4,.69282];
 const dot=u.reduce((sum,n,i)=>sum+n*raw[i],0);
 const v=raw.map((n,i)=>n-dot*u[i]),size=Math.hypot(...v);
 const project=(x,y)=>{
  const p=[-1.1,.35,4].map((n,i)=>n+x*u[i]+y*v[i]/size);
  return [(camera.cx+camera.f*p[0]/p[2])/width,(camera.cy+camera.f*p[1]/p[2])/height];
 };
 const points=[project(0,0),project(4,0),project(4,3),project(0,3)];
 const ratio=estimateRoomAspect(points,width,height);
 assert(Math.abs(ratio-4/3)<.01,'Se recupera la proporción si la perspectiva es estable');
 assert.equal(estimateRoomAspect([[.2,.8],[.8,.8],[.7,.45],[.3,.45]],width,height),null);
 const d=400/ratio;
 assert.equal(validate({points:[[0,0],[400,0],[400,d],[0,d]],height:250,openings:[],items:[]}).edges.length,4);
});

