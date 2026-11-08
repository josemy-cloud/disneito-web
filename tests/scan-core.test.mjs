import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrate,analyseFrame,suggestReference,frameDifference,projectOnWall,validate} from '../disenador-web/scan-core.mjs';
const rect=[[0,0],[400,0],[400,320],[0,320]];
const room=(points=rect,extras={})=>({points,height:255,openings:[],items:[],...extras});
const opening=(ty,wall,p,wd)=>({ty,wall,p,wd,h:ty==='d'?205:110,s:ty==='d'?0:95,confirmed:true});
const item=(x,y,w,d,h,e=0)=>({x,y,w,d,h,e,r:0,confirmed:true});
test('calibra una foto en perspectiva con medidas en cm',()=>{
 const point=(x,y)=>[(.0009*x+.0003*y+.12)/(.001*x+.0009*y+1),(.00025*x+.0013*y+.18)/(.001*x+.0009*y+1)];
 const estimate=calibrate(rect.map(([x,y])=>point(x,y)),400,320)(point(133,217));
 assert(Math.abs(estimate[0]-133)<1e-8&&Math.abs(estimate[1]-217)<1e-8);
});
test('puertas y ventanas, selección confirmada y conflictos',()=>{
 const door=opening('d',0,80,85),win=opening('v',1,140,115);
 assert.equal(validate(room(rect,{openings:[door,win,{...door,confirmed:false}]})).openings.length,2);
 assert.throws(()=>validate(room(rect,{openings:[door,{...door,p:90}]})),/solapan/);
 assert.throws(()=>validate(room(rect,{openings:[{...win,h:200}]})),/fuera/);
 assert.equal(projectOnWall([80,8],rect[0],rect[1]).p,80);
});
test('dormitorio, salón y cocina con objetos del catálogo anotados',()=>{
 for(const items of [[item(120,90,160,200,80),item(280,150,45,40,55)],[item(90,100,180,80,90),item(230,140,80,45,50)],[item(90,70,60,60,90),item(220,75,60,60,180),item(90,70,60,35,65,150)]]){
  assert.equal(validate(room(rect,{items})).items.length,items.length);
 }
 assert.throws(()=>validate(room(rect,{items:[item(90,70,60,35,105,170)]})),/elevación/);
});
test('perímetro irregular y entradas ambiguas',()=>{
 const l=[[0,0],[420,0],[420,140],[180,140],[180,330],[0,330]];
 assert.equal(validate(room(l)).edges.length,6);
 assert.throws(()=>validate(room(l,{items:[item(340,225,50,50,60)]})),/posición/);
 assert.throws(()=>calibrate([[.1,.1],[.6,.7],[.7,.2],[.15,.75]],400,320),/orden/);
 assert.throws(()=>validate(room([[0,0],[400,300],[0,300],[400,0]])));
});
test('calidad y coincidencia de imágenes desplazadas, rechazo de imagen oscura',()=>{
 const size=72;
 const image=(dx,dy,dark=false)=>{
  const p=new Uint8ClampedArray(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   const i=(y*size+x)*4,v=dark?10:40+((Math.imul(x-dx,631)^Math.imul(y-dy,1103)^Math.imul((x-dx)*(y-dy),19211))&127);
   p.set([v,v,v,255],i);
  }
  return analyseFrame(p,size,size);
 };
 const a=image(0,0),b=image(3,2),dark=image(0,0,true);
 assert(Math.abs(dark.brightness-10)<1e-9);assert.equal(dark.sharpness,0);
 assert.equal(frameDifference(a.descriptor,a.descriptor),0);
 const points=[[18,18],[52,18],[52,52],[18,52]].map(p=>p.map(n=>n/size));
 assert.deepEqual(suggestReference(a,b,points),points.map(([x,y])=>[x+3/size,y+2/size]).map(p=>p.map(n=>Math.round(n*size)/size)));
 assert.equal(suggestReference(a,dark,points),null);
});

