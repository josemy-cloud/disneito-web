import {analyseFrame,calibrate,frameDifference,polygonArea,projectOnWall,suggestReference,validate,proposeFloor,estimateRoomAspect,proposeCeiling,estimatePhotoRoom} from './scan-core.mjs';

const FRAME_LIMIT=16;
const VIDEO_LIMIT=200*1024*1024;
const PHOTO_LIMIT=25*1024*1024;
const round=n=>Math.round(n*10)/10;
const wait=(el,event,signal)=>new Promise((resolve,reject)=>{
  if(signal.aborted){reject(signal.reason);return}
  const done=error=>{
    clearTimeout(timer);
    el.removeEventListener(event,success);
    el.removeEventListener('error',failure);
    signal.removeEventListener('abort',abort);
    error?reject(error):resolve();
  };
  const success=()=>done(),failure=()=>done(Error('El navegador no pudo leer este archivo.'));
  const abort=()=>done(signal.reason);
  const timer=setTimeout(()=>done(Error('La lectura del archivo tardó demasiado.')),12000);
  el.addEventListener(event,success,{once:true});
  el.addEventListener('error',failure,{once:true});
  signal.addEventListener('abort',abort,{once:true});
});

function field(parent,label,input){
  const wrap=document.createElement('label');
  wrap.append(label,input);parent.append(wrap);return input;
}
function number(value,min,max){
  const input=document.createElement('input');
  input.type='number';input.min=min;input.max=max;input.step='any';input.value=value??'';
  return input;
}
function button(parent,label,action){
  const b=document.createElement('button');
  b.type='button';b.textContent=label;b.onclick=action;parent.append(b);return b;
}
function options(select,list){
  select.replaceChildren(...list.map(([id,name])=>new Option(name,id)));
}

export function openRoomScanner({catalog,materials,onImport}){
  if(document.querySelector('#scanRoom'))return;
  const d=document.createElement('dialog');
  d.id='scanRoom';d.setAttribute('aria-labelledby','scanTitle');
  d.innerHTML=`
    <header><h2 id="scanTitle">Escanear habitación</h2><button id="scanClose" type="button">Cerrar y descartar</button></header>
    <p>Carga una foto para obtener un plano aproximado. Las capturas se procesan en tu dispositivo y se descartan al cerrar.</p>
    <div class="scan-actions"><button id="scanCamera" type="button">Cámara en directo</button><button id="scanPhotos" type="button">Importar fotografías</button><button id="scanVideo" type="button">Importar vídeo</button></div>
    <label id="scanDrop">También puedes arrastrar fotografías o un vídeo aquí.</label>
    <input id="scanPhotoFiles" type="file" accept="image/*" multiple hidden>
    <input id="scanVideoFile" type="file" accept="video/*" hidden>
    <video id="scanLive" playsinline muted hidden></video>
    <div class="scan-actions" id="scanLiveActions" hidden><button id="scanCapture" type="button">Capturar vista</button><button id="scanStop" type="button">Pausar cámara</button></div>
    <p id="scanNotice" role="status">Añade una vista donde se vean cuatro esquinas del mismo rectángulo en el suelo.</p>
    <progress id="scanProgress" hidden></progress><button id="scanCancel" type="button" hidden>Cancelar lectura</button>
    <section id="scanQuick" hidden>
      <h3>Tu plano aproximado</h3>
      <div class="scan-quick-grid">
        <canvas id="scanQuickImage" class="scan-quick-image" aria-label="Foto con las líneas encontradas"></canvas>
        <div><canvas id="scanQuickPlan" class="scan-plan" width="320" height="180" role="img" aria-label="Plano rectangular aproximado"></canvas>
          <p id="scanQuickSummary"></p>
          <div class="scan-actions"><button id="scanQuickImport" class="scan-primary" type="button">Crear habitación aproximada</button><button id="scanQuickReview" type="button">Ajustar plano</button></div>
        </div>
      </div>
    </section>
    <div id="scanWorkspace" class="scan-columns" hidden>
      <section>
        <h3>1. Capturas y escala</h3><div class="scan-actions" id="scanAuto"></div><div id="scanFrames"></div>
        <p>Marca en orden cuatro esquinas de un rectángulo horizontal que puedas medir. La primera arista es el ancho. En otra vista usa el mismo rectángulo y el mismo orden.</p>
        <div class="scan-fields" id="scanScale"></div>
        <canvas class="scan-image" id="scanImage" aria-label="Vista seleccionada para marcar puntos"></canvas>
        <div class="scan-actions" id="scanMark"></div>
      </section>
      <section>
        <h3>2. Revisión del plano</h3>
        <canvas class="scan-plan" id="scanPlan" width="480" height="320" role="img" aria-label="Vista previa de perímetro, huecos y mobiliario"></canvas>
        <p id="scanSummary"></p>
        <div class="scan-fields" id="scanRoomFields"></div>
        <details><summary>Corregir esquinas</summary><div id="scanPoints"></div></details>
        <details open><summary>Puertas y ventanas</summary><p>Marca dos puntos a ras del suelo para estimar el ancho y la posición, también en ventanas. Confirma la altura y el antepecho en la revisión.</p><div class="scan-actions" id="scanOpeningButtons"></div><div id="scanOpenings"></div></details>
        <details><summary>Muebles de la biblioteca</summary><p>Elige un modelo y marca su centro a ras del suelo. Revisa posición, medidas y giro. Las medidas iniciales son las del catálogo.</p><div class="scan-fields" id="scanCatalogFields"></div><div id="scanItems"></div></details>
        <p>Se importan el perímetro y los elementos que confirmes. Las zonas ocultas requieren revisión.</p>
        <button class="scan-primary" id="scanImport" type="button">Crear habitación en Disenito</button>
      </section>
    </div>`;
  document.body.append(d);
  const $=s=>d.querySelector('#'+s),notice=message=>{$('scanNotice').textContent=message};
  const report=error=>{if(error?.name!=='AbortError'&&!closed)notice(error?.message||String(error))};
  const image=$('scanImage'),live=$('scanLive'),plan=$('scanPlan');
  const frames=[],draft={points:[],geometryMeasured:false,ceilingDraft:false,photoDraft:false,height:250,heightMeasured:false,openings:[],items:[],wallColor:'#f1ede4',floorColor:null,floorMaterial:''};
  let photoEstimate=null,quickFrame=null,proposals=[],proposalIndex=0,ceilingGuide=null,ceilingPoint=null,index=0,mark='reference',openingFirst=null,sampleItem=null,stream=null,cameraEpoch=0,job=null,closed=false,worker=null,analysisId=0;
  const pending=new Map();
  function stopCamera(){
    cameraEpoch++;
    stream?.getTracks().forEach(track=>track.stop());
    stream=null;live.srcObject=null;live.hidden=true;$('scanLiveActions').hidden=true;
  }
  function clearWorker(){
    worker?.terminate();worker=null;
    for(const {reject} of pending.values())reject(new DOMException('Cancelado','AbortError'));
    pending.clear();
  }
  d.addEventListener('keydown',e=>e.stopPropagation());
  function discard(){
    if(closed)return;
    closed=true;job?.abort();stopCamera();clearWorker();
    for(const f of frames){f.canvas.width=0;f.canvas.height=0}
    image.width=0;image.height=0;$('scanQuickImage').width=0;d.remove();
  }
  function closeScanner(){d.close();discard()}
  d.addEventListener('close',discard);
  d.addEventListener('cancel',e=>{e.preventDefault();closeScanner()});
  $('scanClose').onclick=closeScanner;
  try{
    worker=new Worker(new URL('./scan-worker.mjs',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{pending.get(data.id)?.resolve(data.result);pending.delete(data.id)};
    worker.onerror=()=>{
      const waiting=[...pending.values()];pending.clear();worker?.terminate();worker=null;
      for(const {fallback,resolve,reject} of waiting){
        try{resolve(fallback())}catch(error){reject(error)}
      }
    };
  }catch{worker=null}
  function analyseInWorker(data,fallback){
    if(!worker)return Promise.resolve().then(fallback);
    return new Promise((resolve,reject)=>{
      const id=++analysisId;pending.set(id,{fallback,resolve,reject});
      worker.postMessage({id,...data});
    });
  }
  function imagePixels(canvas,maxSize){
    const sample=document.createElement('canvas');
    const scale=Math.min(1,maxSize/Math.max(canvas.width,canvas.height));
    sample.width=Math.max(8,Math.round(canvas.width*scale));sample.height=Math.max(8,Math.round(canvas.height*scale));
    const ctx=sample.getContext('2d',{willReadFrequently:true});
    ctx.drawImage(canvas,0,0,sample.width,sample.height);
    const {data:pixels,width,height}=ctx.getImageData(0,0,sample.width,sample.height);
    return {pixels,width,height};
  }
  function analyse(canvas){
    const data=imagePixels(canvas,144);
    return analyseInWorker(data,()=>analyseFrame(data.pixels,data.width,data.height));
  }
  const quality=f=>[
    f.stats.brightness<43?'poca luz':'',
    f.stats.clipped>.30?'zonas sin detalle':'',
    f.stats.sharpness<3.2?'poco detalle o desenfoque':'',
    f.similar?'parecida a otra captura':''
  ].filter(Boolean).join(' · ');
  async function addFrame(source,w,h,label,signal,skipSimilar=false){
    if(signal.aborted||!w||!h||frames.length>=FRAME_LIMIT)return;
    const factor=Math.min(1,960/Math.max(w,h));
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(w*factor);canvas.height=Math.round(h*factor);
    canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
    const stats=await analyse(canvas);
    if(signal.aborted||closed)return;
    const similar=frames.some(f=>frameDifference(stats.descriptor,f.stats.descriptor)<5);
    if(skipSimilar&&similar)return;
    frames.push({canvas,label,stats,similar,ref:[]});
    $('scanWorkspace').hidden=false;renderFrames();drawImage();
    notice(frames.length+' vistas disponibles. '+(quality(frames.at(-1))||'Marca la referencia de escala o añade otra perspectiva.'));
  }
  async function withJob(run){
    if(job||closed)return;
    const ctl=new AbortController();job=ctl;
    for(const id of ['scanCamera','scanPhotos','scanVideo','scanCapture','scanImport','scanQuickImport','scanQuickReview'])$(id).disabled=true;
    $('scanCancel').hidden=false;
    try{await run(ctl.signal)}
    catch(error){report(error)}
    finally{
      job=null;
      if(!closed){
        for(const id of ['scanCamera','scanPhotos','scanVideo','scanCapture','scanImport','scanQuickImport','scanQuickReview'])$(id).disabled=false;
        $('scanCancel').hidden=true;$('scanProgress').hidden=true;
      }
    }
  }
  $('scanCancel').onclick=()=>{job?.abort();notice('Lectura cancelada. Se conservan las vistas ya preparadas.')};
  $('scanCamera').onclick=async()=>{
    if(stream){stopCamera();return}
    showQuick(false);
    if(!navigator.mediaDevices?.getUserMedia){notice('Cámara web no disponible. Importa fotos o vídeo.');return}
    const epoch=++cameraEpoch;
    $('scanCamera').disabled=true;
    try{
      const opened=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      if(closed||cameraEpoch!==epoch){opened.getTracks().forEach(track=>track.stop());return}
      stream=opened;live.srcObject=stream;live.hidden=false;$('scanLiveActions').hidden=false;
      await live.play();
      notice('Mantén el móvil estable. Captura esquinas distintas y vuelve a mostrar la misma referencia de suelo.');
    }catch{if(!closed){stopCamera();notice('No se pudo abrir la cámara. Revisa el permiso o importa fotos o vídeo.')}}
    finally{if(!closed)$('scanCamera').disabled=false}
  };
  $('scanStop').onclick=()=>{stopCamera();notice('Cámara pausada. Puedes reabrirla o revisar las vistas capturadas.')};
  $('scanCapture').onclick=()=>withJob(async signal=>{
    if(frames.length>=FRAME_LIMIT){notice('Ya hay '+FRAME_LIMIT+' vistas. Quita alguna antes de añadir otra.');return}
    if(!live.videoWidth)throw Error('La cámara todavía no tiene imagen.');
    await addFrame(live,live.videoWidth,live.videoHeight,'Cámara '+(frames.length+1),signal);
  });
  async function photos(files,signal){
    let failed=0,processed=0;
    const list=[...files].slice(0,FRAME_LIMIT-frames.length),progress=$('scanProgress');
    if(!list.length)throw Error('Ya hay 16 vistas. Quita una antes de importar más.');
    progress.max=list.length;progress.value=0;progress.hidden=false;
    for(const file of list){
      if(signal.aborted)break;
      if(file.size>PHOTO_LIMIT){failed++;progress.value=++processed;continue}
      const url=URL.createObjectURL(file),img=new Image();
      try{
        const ready=wait(img,'load',signal);img.src=url;await ready;
        await addFrame(img,img.naturalWidth,img.naturalHeight,'Foto '+(frames.length+1),signal);
      }catch(error){if(signal.aborted)break;failed++}
      finally{URL.revokeObjectURL(url);img.removeAttribute('src')}
      progress.value=++processed;
    }
    if(!signal.aborted&&failed)notice(failed+' fotos no se pudieron leer o superan 25 MB. Prueba JPG, PNG o WebP.');
  }
  async function video(file,signal){
    if(!file||file.size>VIDEO_LIMIT)throw Error('Elige un vídeo de hasta 200 MB.');
    if(frames.length>=FRAME_LIMIT)throw Error('Ya hay 16 vistas. Quita una antes de importar más.');
    const v=document.createElement('video');
    v.muted=true;v.playsInline=true;v.preload='auto';
    const url=URL.createObjectURL(file),progress=$('scanProgress');
    const before=frames.length;
    try{
      const metadata=wait(v,'loadedmetadata',signal);v.src=url;await metadata;
      if(!Number.isFinite(v.duration)||v.duration<.3||!v.videoWidth)throw Error('El vídeo no contiene una duración o imagen válida.');
      const count=Math.min(24,Math.max(3,Math.ceil(v.duration*2)));
      progress.max=count;progress.value=0;progress.hidden=false;
      for(let i=0;i<count&&frames.length<FRAME_LIMIT&&!signal.aborted;i++){
        const ready=wait(v,'seeked',signal);v.currentTime=v.duration*(i+.5)/count;await ready;
        await addFrame(v,v.videoWidth,v.videoHeight,'Vídeo '+v.currentTime.toFixed(1)+' s',signal,true);
        progress.value=i+1;
      }
      if(!signal.aborted)notice((frames.length-before)+' vistas de vídeo conservadas. Las tomas visualmente parecidas se omitieron. Calibra cada vista que vayas a usar.');
    }finally{v.removeAttribute('src');v.load();URL.revokeObjectURL(url)}
  }
  const ingest=(files,kind)=>withJob(async signal=>{
    stopCamera();showQuick(false);
    const previous=frames.length;
    if(kind==='video'){await video(files[0],signal);return}
    await photos(files,signal);
    if(signal.aborted||closed||frames.length===previous||draft.points.length)return;
    await estimateFromPhoto(signal,frames[previous]);
  });
  $('scanPhotos').onclick=()=>$('scanPhotoFiles').click();
  $('scanVideo').onclick=()=>$('scanVideoFile').click();
  for(const [id,kind] of [['scanPhotoFiles','photo'],['scanVideoFile','video']]){
    $(id).onchange=()=>{const files=[...$(id).files];$(id).value='';if(files.length)ingest(files,kind)};
  }
  $('scanDrop').ondragover=e=>e.preventDefault();
  $('scanDrop').ondrop=e=>{
    e.preventDefault();
    const files=[...e.dataTransfer.files],videos=files.filter(f=>f.type.startsWith('video/'));
    if(videos.length&&files.length!==1){notice('Importa un vídeo por vez, separado de las fotos.');return}
    if(files.length)ingest(files,videos.length?'video':'photo');
  };
  const scale=$('scanScale');
  const width=field(scale,'Ancho medido (cm)',number('',20,5000));
  const depth=field(scale,'Fondo medido (cm)',number('',20,5000));
  const updateDepthLabel=()=>{
    width.parentNode.firstChild.textContent=width.dataset.estimated==='true'?'Ancho estimado (cm)':'Ancho medido (cm)';
    depth.parentNode.firstChild.textContent=depth.dataset.estimated==='true'?'Fondo estimado (cm)':'Fondo medido (cm)';
  };
  const transform=()=>{
    if(!width.value||!depth.value)throw Error('Escribe el ancho y el fondo medidos del rectángulo.');
    if(frames[index]?.suggested)throw Error('Comprueba los cuatro puntos sugeridos antes de usar la referencia.');
    return calibrate(frames[index]?.ref||[],+width.value,+depth.value);
  };
  // Si cambia la escala después de anotar, se descartan las anotaciones dependientes con confirmación.
  function rescale(input){
    if(draft.photoDraft&&!draft.openings.length&&!draft.items.length){
      const w=width.valueAsNumber,dep=depth.valueAsNumber;
      if(!(w>=20&&w<=5000&&dep>=20&&dep<=5000)){
        input.value=input.dataset.previous;notice('Escribe una dimensión entre 20 y 5000 cm.');return;
      }
      draft.points=[[0,0],[w,0],[w,dep],[0,dep]];
      input.dataset.previous=input.value;delete input.dataset.estimated;updateDepthLabel();
      renderReview();return;
    }
    if(draft.points.length||draft.items.length||draft.openings.length){
      if(!confirm('Cambiar la escala borra los puntos y elementos marcados. ¿Quieres continuar?')){
        input.value=input.dataset.previous||'';return;
      }
      draft.points=[];draft.geometryMeasured=false;draft.ceilingDraft=false;draft.photoDraft=false;draft.openings=[];draft.items=[];openingFirst=null;renderReview();
    }
    input.dataset.previous=input.value;
    delete input.dataset.estimated;updateDepthLabel();
  }
  width.onchange=()=>rescale(width);depth.onchange=()=>rescale(depth);
  function renderFrames(){
    const box=$('scanFrames');box.replaceChildren();
    frames.forEach((f,i)=>{
      const b=button(box,f.label+(f.suggested?' ?':f.ref.length===4?' ✓':''),()=>{
        index=i;openingFirst=null;renderFrames();drawImage();
        notice(quality(f)||'Vista seleccionada. Puedes marcar la referencia o añadir puntos al plano.');
      });
      b.setAttribute('aria-pressed',String(i===index));b.title=quality(f);
    });
  }
  function drawImage(){
    const f=frames[index];if(!f)return;
    image.width=f.canvas.width;image.height=f.canvas.height;
    const ctx=image.getContext('2d');ctx.drawImage(f.canvas,0,0);
    const proposal=proposals[proposalIndex];
    if(ceilingGuide?.frame===f){
      const segment=(points,color,dashed)=>{
        const [a,b]=points.map(([x,y])=>[x*image.width,y*image.height]);
        ctx.strokeStyle=color;ctx.lineWidth=Math.max(3,image.width/210);
        ctx.setLineDash(dashed?[9,6]:[]);ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();
      };
      for(const side of ceilingGuide.sides)segment(side,'#4fa5ff',true);
      if(ceilingGuide.back)segment(ceilingGuide.back,'#ee513a',false);
      ctx.setLineDash([]);
      if(ceilingPoint){
        ctx.fillStyle='#ee513a';ctx.beginPath();ctx.arc(ceilingPoint[0]*image.width,ceilingPoint[1]*image.height,6,0,2*Math.PI);ctx.fill();
      }
    }
    if(proposal?.frame===f){
      const p=proposal.points.map(([x,y])=>[x*image.width,y*image.height]);
      ctx.lineWidth=Math.max(3,image.width/190);ctx.fillStyle='#257bdb38';ctx.strokeStyle='#50a5ff';
      ctx.beginPath();p.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));
      ctx.closePath();ctx.fill();ctx.stroke();
      ctx.strokeStyle='#ee513a';ctx.lineWidth*=1.5;
      ctx.beginPath();ctx.moveTo(...p[0]);ctx.lineTo(...p[1]);ctx.stroke();
    }
    const marker=f.suggested?'#9d6100':'#176cc1';
    ctx.fillStyle=marker;ctx.strokeStyle='white';ctx.lineWidth=2;ctx.font='bold 14px system-ui';
    f.ref.forEach(([x,y],i)=>{
      ctx.beginPath();ctx.arc(x*image.width,y*image.height,9,0,2*Math.PI);ctx.fill();ctx.stroke();
      ctx.fillStyle='white';ctx.fillText(i+1,x*image.width-4,y*image.height+5);ctx.fillStyle=marker;
    });
  }
  function selectMode(next,message){mark=next;openingFirst=null;notice(message)}
  const auto=$('scanAuto');
  function showProposal(){
    const p=proposals[proposalIndex];
    useProposal.hidden=!p;nextProposal.hidden=proposals.length<2;
    if(!p)return;
    index=frames.indexOf(p.frame);renderFrames();drawImage();
    notice('Propuesta '+(proposalIndex+1)+' de '+proposals.length+' · confianza '+(p.matched?'media (otra vista coincide)':'baja (contorno de color y bordes)')+
      '. Comprueba que el azul sigue el suelo de pared a pared. Mide la arista roja.'+
      (p.aspect?' El fondo se puede estimar.':' Introduce también el fondo medido.'));
  }
  button(auto,'Analizar vídeo o fotos',()=>withJob(async signal=>{
    proposals=[];proposalIndex=0;useProposal.hidden=nextProposal.hidden=true;drawImage();
    const available=frames.filter(f=>f.stats.brightness>=43&&f.stats.clipped<.36&&f.stats.sharpness>=2.5);
    if(!available.length)throw Error('Las vistas tienen poca luz, desenfoque o zonas sin detalle. Añade una toma amplia y estable.');
    const progress=$('scanProgress');progress.max=available.length;progress.value=0;progress.hidden=false;
    notice('Buscando bordes de suelo en las vistas disponibles…');
    const results=[];
    for(const frame of available){
      if(signal.aborted)return;
      const data=imagePixels(frame.canvas,192);
      const result=await analyseInWorker({...data,floor:true},()=>proposeFloor(data));
      if(signal.aborted||closed)return;
      if(result)results.push({...result,frame,aspect:estimateRoomAspect(result.points,data.width,data.height),matched:false});
      progress.value++;
    }
    if(!results.length){
      const guide=await findCeilingGuide(signal);
      if(guide||signal.aborted)return;
      throw Error('No se ve el suelo completo ni una línea fiable de techo. Puedes marcar la pared del fondo o añadir otra toma.');
    }
    notice('Comparando las propuestas con otras vistas…');
    progress.removeAttribute('value');
    results.sort((a,b)=>b.score-a.score);
    for(const candidate of results.slice(0,3)){
      const others=results.filter(q=>q!==candidate&&frameDifference(candidate.frame.stats.descriptor,q.frame.stats.descriptor)>5).slice(0,3);
      for(const target of others){
        const data={source:candidate.frame.stats,target:target.frame.stats,points:candidate.points};
        const matched=await analyseInWorker(data,()=>suggestReference(data.source,data.target,data.points));
        if(signal.aborted||closed)return;
        if(matched&&matched.every((p,i)=>Math.hypot(p[0]-target.points[i][0],p[1]-target.points[i][1])<.045)){
          candidate.matched=true;break;
        }
      }
    }
    proposals=results.sort((a,b)=>Number(b.matched)-Number(a.matched)||b.score-a.score).slice(0,4);
    showProposal();
  }));
  const useProposal=button(auto,'Usar contorno propuesto',()=>{
    const p=proposals[proposalIndex];
    if(!p||job)return;
    try{
      const w=width.valueAsNumber;
      if(!(w>=20&&w<=5000))throw Error('Escribe en «Ancho» la medida real de la arista roja.');
      const estimated=!depth.value||depth.dataset.estimated==='true';
      const d=estimated&&p.aspect?round(w/p.aspect):depth.valueAsNumber;
      if(estimated&&!p.aspect)throw Error('Esta perspectiva necesita dos medidas. Escribe el fondo real antes de usar la propuesta.');
      if(!(d>=20&&d<=5000))throw Error('El fondo calculado queda fuera de rango. Escribe el fondo real.');
      calibrate(p.points,w,d);
      if((draft.points.length||draft.openings.length||draft.items.length)&&!confirm('Esto sustituye el perímetro y borra los elementos marcados. ¿Continuar?'))return;
      index=frames.indexOf(p.frame);p.frame.ref=p.points;p.frame.suggested=false;
      depth.value=d;depth.dataset.previous=d;width.dataset.previous=w;
      if(estimated)depth.dataset.estimated='true';else delete depth.dataset.estimated;
      updateDepthLabel();
      draft.points=[[0,0],[w,0],[w,d],[0,d]];
      draft.geometryMeasured=!estimated&&width.dataset.estimated!=='true';draft.ceilingDraft=false;draft.photoDraft=false;draft.openings=[];draft.items=[];openingFirst=null;mark='reference';
      proposals=[];useProposal.hidden=nextProposal.hidden=true;
      renderFrames();drawImage();renderReview();
      notice(estimated?'Plano creado. Fondo estimado: '+d+' cm. Compruébalo antes de importar.':'Plano creado con tus dos medidas. Revisa la altura y los huecos.');
    }catch(error){report(error)}
  });
  const nextProposal=button(auto,'Ver otra propuesta',()=>{
    proposalIndex=(proposalIndex+1)%proposals.length;showProposal();
  });
  useProposal.hidden=nextProposal.hidden=true;
  async function findCeilingGuide(signal){
    const frame=frames[index];
    if(!frame)return false;
    ceilingGuide=null;ceilingPoint=null;drawImage();
    const data=imagePixels(frame.canvas,256);
    notice('Buscando la unión del techo con las paredes…');
    const found=await analyseInWorker({...data,ceiling:true},()=>proposeCeiling(data));
    if(signal.aborted||closed)return false;
    if(!found){notice('No hay una línea de techo clara. Pulsa «Corregir pared del fondo» y marca sus dos extremos superiores.');return false}
    proposals=[];useProposal.hidden=nextProposal.hidden=true;
    ceilingGuide={frame,...found};ceilingPoint=null;
    index=frames.indexOf(frame);mark='reference';renderFrames();drawImage();
    notice('Guía de confianza baja. Rojo: posible pared del fondo. Azul: posibles laterales. Corrige el tramo rojo si hace falta, escribe el ancho y el fondo medidos y crea el borrador.');
    return true;
  }
  button(auto,'Desde techo y paredes',()=>withJob(findCeilingGuide));
  button(auto,'Corregir pared del fondo',()=>{
    if(job||!frames[index])return;
    const frame=frames[index];
    if(ceilingGuide?.frame!==frame)ceilingGuide={frame,back:null,sides:[]};
    ceilingPoint=null;proposals=[];useProposal.hidden=nextProposal.hidden=true;
    selectMode('ceiling-back','Marca los dos extremos donde la pared del fondo se une al techo.');
    drawImage();
  });
  button(auto,'Crear borrador desde el techo',()=>{
    if(job)return;
    try{
      if(!ceilingGuide?.back)throw Error('Busca o marca primero la línea superior de la pared del fondo.');
      const w=width.valueAsNumber,d=depth.valueAsNumber;
      if(!(w>=20&&w<=5000&&d>=20&&d<=5000)||depth.dataset.estimated==='true')
        throw Error('Introduce el ancho real de la pared del fondo y el fondo real de la habitación.');
      if((draft.points.length||draft.items.length||draft.openings.length)&&
         !confirm('Esto sustituye el perímetro y los elementos marcados por un borrador rectangular. ¿Continuar?'))return;
      draft.points=[[0,0],[w,0],[w,d],[0,d]];
      draft.geometryMeasured=false;draft.ceilingDraft=true;draft.photoDraft=false;draft.openings=[];draft.items=[];
      width.dataset.previous=w;depth.dataset.previous=d;
      for(const frame of frames){frame.ref=[];frame.suggested=false}
      index=frames.indexOf(ceilingGuide.frame);mark='reference';openingFirst=null;ceilingPoint=null;
      renderFrames();drawImage();renderReview();
      notice('Borrador rectangular creado con tus medidas. Los laterales y el cierre que no se ven quedan para revisión. La línea del techo no calibra el suelo.');
    }catch(error){report(error)}
  });
  function showQuick(open){
    $('scanQuick').hidden=!open;
    d.classList.toggle('scan-quick-active',open);
  }
  async function estimateFromPhoto(signal,frame=frames[index]){
    if(!frame)return;
    showQuick(false);photoEstimate=null;quickFrame=null;
    notice('Buscando el suelo y las líneas del techo…');
    const data=imagePixels(frame.canvas,256);
    const ceiling=await analyseInWorker({...data,ceiling:true},()=>proposeCeiling(data));
    if(signal.aborted||closed)return;
    const floorData=imagePixels(frame.canvas,192);
    const floor=await analyseInWorker({...floorData,floor:true},()=>proposeFloor(floorData));
    if(signal.aborted||closed)return;
    const aspect=floor&&estimateRoomAspect(floor.points,floorData.width,floorData.height);
    photoEstimate=estimatePhotoRoom({ceiling,floor,aspect,width:data.width,height:data.height});
    if(!photoEstimate){notice('La foto no muestra líneas claras de pared, techo o suelo. Prueba con una vista más amplia.');return}
    quickFrame=frame;index=frames.indexOf(frame);
    ceilingGuide=ceiling?{frame,...ceiling}:null;ceilingPoint=null;
    proposals=floor?[{...floor,frame}]:[];proposalIndex=0;
    useProposal.hidden=nextProposal.hidden=true;
    renderFrames();drawImage();
    const photo=$('scanQuickImage');
    photo.width=image.width;photo.height=image.height;
    photo.getContext('2d').drawImage(image,0,0);
    const p=$('scanQuickPlan'),ctx=p.getContext('2d'),{width:w,depth:dep,height:h,depthInferred}=photoEstimate;
    ctx.clearRect(0,0,p.width,p.height);
    const k=Math.min(248/w,120/dep),rw=w*k,rd=dep*k,x=(p.width-rw)/2,y=(p.height-rd)/2;
    ctx.fillStyle='#dbe8f8';ctx.fillRect(x,y,rw,rd);
    ctx.strokeStyle='#185da8';ctx.lineWidth=3;ctx.setLineDash([6,4]);ctx.strokeRect(x,y,rw,rd);ctx.setLineDash([]);
    $('scanQuickSummary').textContent='Ancho orientativo '+w+' cm · fondo '+(depthInferred?'estimado ':'supuesto ')+dep+' cm · altura de referencia '+h+' cm. Forma rectangular provisional.';
    showQuick(true);
    notice('Plano aproximado listo. Puedes crearlo directamente o ajustar la propuesta.');
  }
  function preparePhotoDraft(){
    if(!photoEstimate||!frames.includes(quickFrame))throw Error('Vuelve a analizar la foto.');
    const {width:w,depth:dep,height:h}=photoEstimate;
    draft.points=[[0,0],[w,0],[w,dep],[0,dep]];
    draft.geometryMeasured=false;draft.ceilingDraft=false;draft.photoDraft=true;
    draft.height=h;draft.heightMeasured=false;height.value=h;measured.checked=false;
    draft.openings=[];draft.items=[];openingFirst=null;
    width.value=w;depth.value=dep;width.dataset.previous=w;depth.dataset.previous=dep;
    width.dataset.estimated=depth.dataset.estimated='true';updateDepthLabel();
    for(const frame of frames){frame.ref=[];frame.suggested=false}
    index=frames.indexOf(quickFrame);renderFrames();drawImage();renderReview();
  }
  $('scanQuickImport').onclick=()=>{
    if(job)return;
    try{preparePhotoDraft();importDraft()}catch(error){report(error)}
  };
  $('scanQuickReview').onclick=()=>{
    if(job)return;
    try{
      preparePhotoDraft();showQuick(false);
      notice('Puedes corregir el borrador antes de importar. Las medidas proceden de una estimación de la foto.');
    }catch(error){report(error)}
  };
  button(auto,'Borrador rápido sin medidas',()=>withJob(async signal=>{
    if((draft.points.length||draft.items.length||draft.openings.length)&&
       !confirm('El borrador rápido sustituirá el plano y los elementos marcados si lo aceptas. ¿Continuar?'))return;
    await estimateFromPhoto(signal);
  }));
  const markButtons=$('scanMark');
  button(markButtons,'Marcar referencia',()=>selectMode('reference','Marca las cuatro esquinas de la referencia, en orden.'));
  button(markButtons,'Rehacer referencia de esta vista',()=>{
    if(frames[index]){frames[index].ref=[];frames[index].suggested=false}
    selectMode('reference','Marca las cuatro esquinas en el mismo orden. Los puntos ya incorporados al plano se conservan.');renderFrames();drawImage();
  });
  button(markButtons,'Sugerir referencia en esta vista',()=>withJob(async signal=>{
    const target=frames[index];
    if(!target||target.ref.length)throw Error('La sugerencia requiere una vista sin marcas.');
    const source=frames.map((f,i)=>({f,gap:Math.abs(i-index)}))
      .filter(q=>q.f!==target&&q.f.ref.length===4&&!q.f.suggested).sort((a,b)=>a.gap-b.gap)[0]?.f;
    if(!source)throw Error('Calibra una vista cercana antes de intentar encontrar los mismos puntos.');
    const data={source:source.stats,target:target.stats,points:source.ref};
    const points=await analyseInWorker(data,()=>suggestReference(data.source,data.target,data.points));
    if(signal.aborted||closed)return;
    if(!points)throw Error('No se encontraron cuatro coincidencias claras. Marca la referencia a mano.');
    calibrate(points,100,100);
    target.ref=points;target.suggested=true;index=frames.indexOf(target);
    renderFrames();drawImage();
    notice('Referencia sugerida con confianza media. Confirma que son las mismas cuatro esquinas y en el mismo orden.');
  }));
  button(markButtons,'Confirmar referencia sugerida',()=>{
    const f=frames[index];
    if(!f?.suggested){notice('La vista actual no tiene una referencia pendiente de confirmar.');return}
    f.suggested=false;renderFrames();drawImage();notice('Referencia confirmada.');
  });
  button(markButtons,'Usar rectángulo como habitación',()=>{
    try{
      transform();
      if((draft.points.length||draft.openings.length)&&!confirm('Esto sustituye el perímetro y sus huecos marcados. ¿Continuar?'))return;
      draft.points=[[0,0],[+width.value,0],[+width.value,+depth.value],[0,+depth.value]];
      draft.geometryMeasured=depth.dataset.estimated!=='true'&&width.dataset.estimated!=='true';draft.ceilingDraft=false;draft.photoDraft=false;draft.openings=[];openingFirst=null;renderReview();notice('Perímetro rectangular creado con las medidas aportadas. Revisa altura y huecos.');
    }catch(error){report(error)}
  });
  button(markButtons,'Añadir esquina de pared',()=>selectMode('vertex','Marca una esquina a ras del suelo. Añade las esquinas en orden, aunque cambies de vista.'));
  button(markButtons,'Quitar esta vista',()=>{
    if(job)return;
    const frame=frames.splice(index,1)[0];
    if(frame){frame.canvas.width=0;frame.canvas.height=0}
    proposals=[];useProposal.hidden=nextProposal.hidden=true;
    if(ceilingGuide?.frame===frame){ceilingGuide=null;ceilingPoint=null}
    index=Math.max(0,Math.min(index,frames.length-1));openingFirst=null;
    renderFrames();drawImage();$('scanWorkspace').hidden=frames.length===0;
    notice('Vista descartada. Las anotaciones ya proyectadas se conservan.');
  });
  const openButtons=$('scanOpeningButtons');
  button(openButtons,'Marcar puerta',()=>selectMode('d','Marca los dos extremos del hueco a ras del suelo.'));
  button(openButtons,'Marcar ventana',()=>selectMode('v','Marca en el suelo los dos extremos proyectados bajo la ventana.'));
  const catalogFields=$('scanCatalogFields'),search=field(catalogFields,'Buscar en la biblioteca',document.createElement('input'));
  search.type='search';
  const models=field(catalogFields,'Modelo',document.createElement('select'));
  function filterModels(){
    const q=search.value.trim().toLocaleLowerCase('es');
    options(models,catalog.filter(m=>m.name.toLocaleLowerCase('es').includes(q)).slice(0,80).map(m=>[m.id,m.name]));
  }
  search.oninput=filterModels;filterModels();
  button(catalogFields,'Marcar posición del mueble',()=>selectMode('item','Marca el centro del mueble a ras del suelo. Revisa el modelo y sus medidas.'));
  const settings=$('scanRoomFields');
  const height=field(settings,'Altura de paredes (cm)',number(250,100,1000));
  const measured=field(settings,'Altura medida',document.createElement('input'));measured.type='checkbox';
  height.onchange=()=>{draft.height=height.valueAsNumber;renderReview()};
  measured.onchange=()=>{draft.heightMeasured=measured.checked;renderReview()};
  const wallColor=field(settings,'Color de paredes',document.createElement('input'));wallColor.type='color';wallColor.value=draft.wallColor;
  wallColor.oninput=()=>{draft.wallColor=wallColor.value};
  button(settings,'Muestrear pared',()=>selectMode('wallColor','Toca una zona de pared sin brillo ni sombra marcada.'));
  const floor=field(settings,'Material del suelo',document.createElement('select'));
  options(floor,[['','Predeterminado del proyecto'],['observed','Color observado'],...materials]);
  floor.onchange=()=>{draft.floorMaterial=floor.value};
  button(settings,'Muestrear suelo',()=>selectMode('floorColor','Toca una zona de suelo sin brillo ni sombra marcada.'));
  let suggestedFloor=null;
  const useFloorSuggestion=button(settings,'Usar PBR sugerido por color',()=>{
    if(!suggestedFloor)return;
    draft.floorMaterial=floor.value=suggestedFloor[0];
    notice('Material elegido por similitud de color. Comprueba la textura en 3D.');
  });
  useFloorSuggestion.hidden=true;
  function closestFloorColor(hex){
    const rgb=value=>value.match(/[a-f0-9]{2}/gi)?.map(n=>parseInt(n,16));
    const a=rgb(hex);
    const candidates=materials.flatMap(entry=>{
      const b=rgb(entry[2]||'');
      return b?.length===3?[{entry,distance:Math.hypot(...a.map((n,i)=>n-b[i]))}]:[];
    }).sort((a,b)=>a.distance-b.distance);
    return candidates[0]?.distance<=45?candidates[0].entry:null;
  }
  function sampleColor(f,point){
    const {canvas}=f,ctx=canvas.getContext('2d');
    const x=Math.min(canvas.width-1,Math.floor(point[0]*canvas.width)),y=Math.min(canvas.height-1,Math.floor(point[1]*canvas.height));
    const left=Math.max(0,x-4),top=Math.max(0,y-4);
    const data=ctx.getImageData(left,top,Math.min(9,canvas.width-left),Math.min(9,canvas.height-top)).data;
    const values=[[],[],[]];
    for(let i=0;i<data.length;i+=4)for(let j=0;j<3;j++)values[j].push(data[i+j]);
    return '#'+values.map(v=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)].toString(16).padStart(2,'0')).join('');
  }
  image.onclick=e=>{
    const f=frames[index];if(!f)return;
    const b=image.getBoundingClientRect(),point=[(e.clientX-b.left)/b.width,(e.clientY-b.top)/b.height];
    try{
      if(mark==='ceiling-back'){
        if(point[1]>.58)throw Error('Marca el borde superior de la pared, junto al techo.');
        if(ceilingGuide?.frame!==f){ceilingGuide={frame:f,back:null,sides:[]};ceilingPoint=null}
        if(!ceilingPoint){ceilingPoint=point;drawImage();notice('Marca el otro extremo superior de la pared del fondo.');return}
        if(Math.abs(ceilingPoint[0]-point[0])<.15||Math.abs(ceilingPoint[1]-point[1])>.25)
          throw Error('Los puntos no definen un tramo claro de pared. Marca el extremo contrario.');
        ceilingGuide.back=[ceilingPoint,point].sort((a,b)=>a[0]-b[0]);ceilingPoint=null;
        mark='reference';drawImage();notice('Pared del fondo marcada. Introduce las dos medidas y crea el borrador desde el techo.');
        return;
      }
      if(mark==='reference'){
        if(f.ref.length===4)throw Error('Esta vista ya tiene cuatro puntos. Elige una herramienta o rehace la referencia.');
        f.ref.push(point);drawImage();renderFrames();
        if(f.ref.length===4){transform();notice('Vista calibrada. Genera el rectángulo o marca el perímetro real.')}
        else notice(f.ref.length+' de 4 esquinas de referencia marcadas.');
        return;
      }
      if(['wallColor','floorColor','itemColor'].includes(mark)){
        const color=sampleColor(f,point);
        if(mark==='wallColor')draft.wallColor=wallColor.value=color;
        else if(mark==='floorColor'){
          draft.floorColor=color;draft.floorMaterial=floor.value='observed';
          suggestedFloor=closestFloorColor(color);useFloorSuggestion.hidden=!suggestedFloor;
        }else if(sampleItem&&draft.items.includes(sampleItem)){
          sampleItem.color=color;sampleItem.colorEdited=true;renderReview();
        }
        const suggestion=mark==='floorColor'&&suggestedFloor?' PBR por color (confianza baja): '+suggestedFloor[1]+'.':'';
        notice('Color observado '+color+'. La luz de la foto puede alterar el tono.'+suggestion);return;
      }
      const metric=transform()(point).map(round);
      if(mark==='vertex'){
        if(draft.points.length>=32)throw Error('El perímetro admite hasta 32 esquinas.');
        if(draft.openings.length)throw Error('Quita los huecos antes de cambiar el número de paredes.');
        draft.geometryMeasured=false;draft.ceilingDraft=false;draft.photoDraft=false;draft.points.push(metric);notice('Esquina '+draft.points.length+' añadida con posición estimada.');
      }else if(mark==='item'){
        const model=catalog.find(m=>String(m.id)===models.value);
        if(!model)throw Error('Elige un modelo de la biblioteca.');
        if(draft.items.length>=60)throw Error('Se admiten hasta 60 muebles por reconstrucción.');
        if(draft.items.some(i=>i.model===model.id&&Math.hypot(i.x-metric[0],i.y-metric[1])<Math.min(i.w,i.d)*.30)&&
           !confirm('Ya hay un mueble de ese modelo cerca de este punto. ¿Es una pieza distinta?'))return;
        draft.items.push({model:model.id,name:model.name,x:metric[0],y:metric[1],w:model.w,d:model.d,h:model.h,e:model.e,r:0,color:model.color,confirmed:false});
        notice('Mueble añadido a revisión. Confírmalo antes de importar.');
      }else{
        if(draft.points.length<3)throw Error('Completa el perímetro antes de marcar huecos.');
        if(!openingFirst){openingFirst=metric;notice('Marca el segundo extremo del hueco.');return}
        const first=openingFirst;openingFirst=null;
        const matches=draft.points.map((a,i)=>{
          const b=draft.points[(i+1)%draft.points.length];
          return {wall:i,a:projectOnWall(first,a,b),b:projectOnWall(metric,a,b)};
        }).filter(q=>[q.a,q.b].every(p=>p.error<=25&&p.p>=0&&p.p<=p.length));
        matches.sort((a,b)=>a.a.error+a.b.error-b.a.error-b.b.error);
        const q=matches[0];
        if(!q||Math.abs(q.a.p-q.b.p)<15)throw Error('Los extremos no encajan en una misma pared. Vuelve a marcar ambos.');
        if(draft.openings.length>=48)throw Error('Se admiten hasta 48 huecos por reconstrucción.');
        draft.openings.push({wall:q.wall,ty:mark,p:round((q.a.p+q.b.p)/2),wd:round(Math.abs(q.a.p-q.b.p)),h:mark==='d'?205:110,s:mark==='d'?0:90,confirmed:false});
        notice('Hueco añadido a revisión. Revisa sus medidas y confírmalo.');
      }
      renderReview();
    }catch(error){report(error)}
  };
  function reviewNumber(parent,label,record,key,min,max){
    const input=field(parent,label,number(record[key],min,max));
    input.onchange=()=>{record[key]=input.valueAsNumber;if(Array.isArray(record))draft.geometryMeasured=false;drawPlan()};
  }
  function recordFields(parent,record,fields,remove,label){
    const div=document.createElement('div');div.className='scan-fields';parent.append(div);
    const confirmBox=field(div,label,document.createElement('input'));
    confirmBox.type='checkbox';confirmBox.checked=record.confirmed;
    confirmBox.onchange=()=>{record.confirmed=confirmBox.checked;drawPlan()};
    for(const args of fields)reviewNumber(div,args[0],record,...args.slice(1));
    button(div,'Quitar',remove);
    return div;
  }
  function renderReview(){
    const pointBox=$('scanPoints'),openBox=$('scanOpenings'),itemBox=$('scanItems');
    pointBox.replaceChildren();openBox.replaceChildren();itemBox.replaceChildren();
    draft.points.forEach((p,i)=>{
      const div=document.createElement('div');div.className='scan-fields';pointBox.append(div);
      reviewNumber(div,'Esquina '+(i+1)+' · X (cm)',p,0,-10000,10000);
      reviewNumber(div,'Y (cm)',p,1,-10000,10000);
      const remove=button(div,'Quitar esquina',()=>{draft.points.splice(i,1);draft.geometryMeasured=false;renderReview()});
      remove.disabled=draft.openings.length>0;
    });
    draft.openings.forEach((o,i)=>{
      const div=recordFields(openBox,o,[['Centro (cm)','p',0,10000],['Ancho (cm)','wd',15,10000],['Altura (cm)','h',15,1000],['Antepecho (cm)','s',0,1000]],
        ()=>{draft.openings.splice(i,1);renderReview()},'Confirmar '+(o.ty==='d'?'puerta':'ventana')+' · confianza media (posición estimada)');
      const wall=field(div,'Pared',document.createElement('select'));
      options(wall,draft.points.map((_,n)=>[n,'Pared '+(n+1)]));wall.value=o.wall;
      wall.onchange=()=>{o.wall=+wall.value;drawPlan()};
    });
    draft.items.forEach((it,i)=>{
      const div=recordFields(itemBox,it,[['X (cm)','x',-10000,10000],['Y (cm)','y',-10000,10000],['Ancho (cm)','w',2,1200],['Fondo (cm)','d',2,1200],['Alto (cm)','h',2,1200],['Elevación (cm)','e',0,1000],['Giro (°)','r',-360,360]],
        ()=>{draft.items.splice(i,1);renderReview()},'Confirmar '+it.name+' · coincidencia manual');
      const color=field(div,'Color del mueble',document.createElement('input'));color.type='color';color.value=it.color;
      color.oninput=()=>{it.color=color.value;it.colorEdited=true;drawPlan()};
      button(div,'Usar el modelo elegido arriba',()=>{
        const model=catalog.find(m=>String(m.id)===models.value);
        if(!model)return;
        Object.assign(it,{model:model.id,name:model.name,w:model.w,d:model.d,h:model.h,e:model.e,color:model.color,colorEdited:false,confirmed:false});
        renderReview();
      });
      button(div,'Muestrear color del mueble',()=>{
        sampleItem=it;selectMode('itemColor','Toca una zona del mueble sin brillo ni sombra marcada.');
      });
    });
    drawPlan();
  }
  function drawPlan(){
    const ctx=plan.getContext('2d');
    ctx.clearRect(0,0,plan.width,plan.height);
    const points=draft.points.filter(p=>p.every(Number.isFinite));
    $('scanSummary').textContent=points.length<3?'Perímetro incompleto. Marca esquinas visibles o usa la referencia rectangular.':
      points.length+' esquinas · '+(polygonArea(points)/10000).toFixed(2)+' m² · perímetro '+((draft.ceilingDraft||draft.photoDraft)?'rectangular provisional · líneas discontinuas por revisar':draft.geometryMeasured?'según medidas aportadas':'estimado')+' · altura '+(draft.heightMeasured?'medida':'estimada')+'.';
    if(!points.length)return;
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x0=Math.min(...xs),y0=Math.min(...ys);
    const k=Math.min((plan.width-48)/Math.max(20,Math.max(...xs)-x0),(plan.height-48)/Math.max(20,Math.max(...ys)-y0));
    const xy=(x,y)=>[24+(x-x0)*k,24+(y-y0)*k];
    ctx.strokeStyle='#203b62';ctx.fillStyle='#dbe8f8';ctx.lineWidth=4;
    ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(...xy(...p)):ctx.moveTo(...xy(...p)));
    if(points.length>2){ctx.closePath();ctx.fill()}
    if((draft.ceilingDraft||draft.photoDraft)&&points.length===4){
      ctx.setLineDash([8,6]);ctx.stroke();ctx.setLineDash([]);
      ctx.beginPath();ctx.moveTo(...xy(...points[0]));ctx.lineTo(...xy(...points[1]));ctx.stroke();
    }else ctx.stroke();
    ctx.font='13px system-ui';
    points.forEach((p,i)=>{const q=xy(...p);ctx.fillStyle='#185da8';ctx.fillRect(q[0]-4,q[1]-4,8,8);ctx.fillText(i+1,q[0]+7,q[1]+13)});
    for(const o of draft.openings){
      const a=draft.points[o.wall],b=draft.points[(o.wall+1)%draft.points.length];
      if(!a||!b)continue;
      const l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!l)continue;
      const point=p=>xy(a[0]+p*(b[0]-a[0])/l,a[1]+p*(b[1]-a[1])/l);
      ctx.strokeStyle=o.confirmed?'#176cc1':'#c38b23';ctx.lineWidth=7;
      ctx.beginPath();ctx.moveTo(...point(o.p-o.wd/2));ctx.lineTo(...point(o.p+o.wd/2));ctx.stroke();
    }
    for(const i of draft.items){
      ctx.save();ctx.translate(...xy(i.x,i.y));ctx.rotate(i.r*Math.PI/180);
      ctx.fillStyle=i.color;ctx.globalAlpha=i.confirmed?.9:.45;
      ctx.fillRect(-i.w*k/2,-i.d*k/2,i.w*k,i.d*k);ctx.restore();
    }
  }
  function importDraft(){
    if(!frames.length)throw Error('Añade al menos una captura.');
    if(draft.floorMaterial==='observed'&&!draft.floorColor)throw Error('Muestrea un color de suelo o elige un material.');
    const result=validate(draft);
    const method=draft.photoDraft?'photo-estimate':draft.ceilingDraft?'ceiling-guide':'planar-reference';
    onImport({...result,method,geometryMeasured:draft.geometryMeasured,height:draft.height,heightMeasured:draft.heightMeasured,
      wallColor:draft.wallColor,floorColor:draft.floorColor,floorMaterial:draft.floorMaterial});
    closeScanner();
  }
  $('scanImport').onclick=()=>{try{importDraft()}catch(error){report(error)}};
  renderReview();d.showModal();
}




