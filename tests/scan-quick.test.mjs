import test from 'node:test';
import assert from 'node:assert/strict';
import {estimatePhotoRoom} from '../disenador-web/scan-core.mjs';
test('propone un plano sin escala y distingue el fondo supuesto',()=>{
 const r=estimatePhotoRoom({ceiling:{back:[[.2656,.1382],[.7617,.1691]]},width:256,height:144});
 assert.deepEqual(r,{width:280,depth:310,height:250,depthInferred:false});
});
test('usa la proporción del suelo si es estable y descarta una vista sin guía',()=>{
 assert.equal(estimatePhotoRoom({floor:{points:[[0,0],[1,0],[1,1],[0,1]]},aspect:2,width:256,height:144}).depthInferred,true);
 assert.equal(estimatePhotoRoom({width:256,height:144}),null);
});

