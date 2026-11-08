// Private evaluation of the pinned SegFormer B0 ONNX checkpoint.
const RUNTIME='https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
const SIDE=512;
let ort,session;
self.onmessage=async({data})=>{
  const {id,model,pixels}=data;
  try{
    if(model){
      ort=await import(RUNTIME+'ort.wasm.min.mjs');
      ort.env.wasm.numThreads=1;
      ort.env.wasm.wasmPaths={
        mjs:RUNTIME+'ort-wasm-simd-threaded.mjs',
        wasm:RUNTIME+'ort-wasm-simd-threaded.wasm'
      };
      session=await ort.InferenceSession.create(model,{executionProviders:['wasm']});
      self.postMessage({id,ready:true});
      return;
    }
    if(!session||pixels?.length!==SIDE*SIDE*4)throw Error('El modelo o la imagen no están preparados.');
    const area=SIDE*SIDE,input=new Float32Array(area*3);
    const mean=[.485,.456,.406],std=[.229,.224,.225];
    for(let i=0;i<area;i++)for(let c=0;c<3;c++)input[c*area+i]=(pixels[4*i+c]/255-mean[c])/std[c];
    const tensor=new ort.Tensor('float32',input,[1,3,SIDE,SIDE]);
    const results=await session.run({[session.inputNames[0]]:tensor});
    const output=results[session.outputNames[0]];
    const [,classes,height,width]=output.dims,plane=width*height;
    if(classes!==150||!plane)throw Error('El modelo devolvió un formato inesperado.');
    const labels=new Uint8Array(plane),scores=output.data;
    for(let p=0;p<plane;p++){
      let best=-Infinity;
      for(let c=0;c<classes;c++){
        const score=scores[c*plane+p];
        if(score>best){labels[p]=c;best=score}
      }
    }
    tensor.dispose();output.dispose();
    self.postMessage({id,labels,width,height},[labels.buffer]);
  }catch(error){self.postMessage({id,error:error?.message||String(error)})}
};
