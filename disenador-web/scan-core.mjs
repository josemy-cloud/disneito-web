// Planar calibration and room validation. Coordinates in the draft are centimetres.
const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const distance = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);

export function calibrate(points, width, depth) {
  if (points.length !== 4 || !(width >= 20 && width <= 5000 && depth >= 20 && depth <= 5000))
    throw Error('Marca las cuatro esquinas de la referencia y escribe sus dos medidas.');
  const turns = points.map((p,i) => cross(p,points[(i+1)%4],points[(i+2)%4]));
  if (!(turns.every(n=>n>0.001) || turns.every(n=>n<-.001)))
    throw Error('Las esquinas deben ir en orden alrededor de un rectángulo visible, sin cruzarse.');
  const targets = [[0,0],[1,0],[1,1],[0,1]];
  const rows = points.flatMap(([x,y],i) => {
    const [u,v] = targets[i];
    return [[x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]];
  });
  for (let i=0;i<8;i++) {
    let pivot=i;
    for(let j=i+1;j<8;j++) if(Math.abs(rows[j][i])>Math.abs(rows[pivot][i]))pivot=j;
    [rows[i],rows[pivot]]=[rows[pivot],rows[i]];
    const n=rows[i][i];
    if(Math.abs(n)<1e-8)throw Error('Referencia degenerada. Elige una toma con mejor perspectiva.');
    rows[i]=rows[i].map(v=>v/n);
    for(let j=0;j<8;j++)if(j!==i){
      const factor=rows[j][i];
      rows[j]=rows[j].map((v,k)=>v-factor*rows[i][k]);
    }
  }
  const [a,b,c,d,e,f,g,h]=rows.map(row=>row[8]);
  return ([x,y])=>{
    const z=g*x+h*y+1;
    const result=[width*(a*x+b*y+c)/z,depth*(d*x+e*y+f)/z];
    if(Math.abs(z)<.025 || !result.every(n=>Number.isFinite(n)&&Math.abs(n)<=10000))
      throw Error('El punto queda demasiado cerca del horizonte de la imagen. Prueba otra toma.');
    return result;
  };
}

export function polygonArea(points) {
  return Math.abs(points.reduce((sum,[x,y],i)=>{
    const [nx,ny]=points[(i+1)%points.length];
    return sum+x*ny-y*nx;
  },0))/2;
}

function intersects(a,b,c,d) {
  if(Math.max(a[0],b[0])<Math.min(c[0],d[0])||Math.max(c[0],d[0])<Math.min(a[0],b[0])||
     Math.max(a[1],b[1])<Math.min(c[1],d[1])||Math.max(c[1],d[1])<Math.min(a[1],b[1]))return false;
  return cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0;
}

export function within(point, polygon) {
  let inside=false;
  const [x,y]=point;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [a,b]=polygon[i],[c,d]=polygon[j];
    if((b>y)!==(d>y) && x<(c-a)*(y-b)/(d-b)+a)inside=!inside;
  }
  return inside;
}

export function projectOnWall(point,a,b) {
  const length=distance(a,b);
  if(length<1)return {p:0,error:Infinity,length};
  const x=(b[0]-a[0])/length,y=(b[1]-a[1])/length;
  return {p:(point[0]-a[0])*x+(point[1]-a[1])*y,error:Math.abs(cross(a,b,point))/length,length};
}

export function validate(draft) {
  const {points,height,openings,items}=draft;
  if(points.length<3 || points.length>32 || !points.every(p=>p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<=10000)))
    throw Error('El perímetro necesita de 3 a 32 esquinas válidas.');
  if(!(height>=100&&height<=1000))throw Error('Indica una altura entre 100 y 1000 cm.');
  if(polygonArea(points)<2500)throw Error('La superficie es demasiado pequeña. Revisa la escala.');
  const edges=points.map((p,i)=>[p,points[(i+1)%points.length]]);
  edges.forEach(([a,b],i)=>{
    if(distance(a,b)<20)throw Error('Cada tramo debe medir al menos 20 cm.');
    for(let j=i+2;j<edges.length;j++){
      if(i===0&&j===edges.length-1)continue;
      if(intersects(a,b,...edges[j]))throw Error('El perímetro se cruza. Revisa el orden de las esquinas.');
    }
  });
  const accepted=openings.filter(o=>o.confirmed);
  for(const [i,o] of accepted.entries()){
    const edge=edges[o.wall];
    if(!edge||!['d','v'].includes(o.ty)||![o.p,o.wd,o.h,o.s].every(Number.isFinite)||
      o.wd<15||o.h<15||o.s<0||o.h+o.s>height||o.p-o.wd/2<0||o.p+o.wd/2>distance(...edge))
      throw Error('Hay una puerta o ventana confirmada fuera de su pared. Revisa sus medidas.');
    if(accepted.slice(0,i).some(q=>q.wall===o.wall&&Math.abs(o.p-q.p)<(o.wd+q.wd)/2-.01))
      throw Error('Dos aperturas confirmadas se solapan.');
  }
  for(const i of items.filter(o=>o.confirmed)){
    if(![i.x,i.y,i.w,i.d,i.h,i.r,i.e].every(Number.isFinite)||!within([i.x,i.y],points)||
       i.e<0||i.e+i.h>height||[i.w,i.d,i.h].some(n=>n<2||n>1200))throw Error('Revisa la posición, las dimensiones y la elevación de los muebles confirmados.');
  }
  return {edges,openings:accepted,items:items.filter(i=>i.confirmed)};
}

export function analyseFrame(pixels,width,height) {
  const luminance=new Float32Array(width*height);
  let sum=0,clipped=0,edges=0;
  for(let i=0;i<luminance.length;i++){
    const j=i*4,l=pixels[j]*.2126+pixels[j+1]*.7152+pixels[j+2]*.0722;
    luminance[i]=l;sum+=l;if(l<12||l>248)clipped++;
  }
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;
    edges+=Math.abs(luminance[i-1]+luminance[i+1]+luminance[i-width]+luminance[i+width]-4*luminance[i]);
  }
  const descriptor=[];
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    let total=0,count=0;
    for(let yy=Math.floor(y*height/8);yy<Math.floor((y+1)*height/8);yy++)
      for(let xx=Math.floor(x*width/8);xx<Math.floor((x+1)*width/8);xx++){total+=luminance[yy*width+xx];count++}
    descriptor.push(total/Math.max(1,count));
  }
  return {brightness:sum/luminance.length,clipped:clipped/luminance.length,
    sharpness:edges/Math.max(1,(width-2)*(height-2)),descriptor,luminance,width,height};
}

export function frameDifference(a,b) {
  const mean=arr=>arr.reduce((sum,n)=>sum+n,0)/arr.length;
  const ma=mean(a),mb=mean(b);
  return mean(a.map((n,i)=>Math.abs((n-ma)-(b[i]-mb))));
}

// Local, contrast-normalized patch matching. Only a suggestion for nearby viewpoints.
export function suggestReference(source,target,points) {
  const radius=4;
  function patch(frame,x,y){
    const {luminance,width,height}=frame;
    if(x<radius||y<radius||x>=width-radius||y>=height-radius)return null;
    const values=[];
    let sum=0,squares=0;
    for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){
      const v=luminance[(y+dy)*width+x+dx];
      values.push(v);sum+=v;squares+=v*v;
    }
    const mean=sum/values.length,norm=Math.sqrt(Math.max(0,squares-sum*mean));
    return norm<40?null:values.map(v=>(v-mean)/norm);
  }
  const matches=points.map(([u,v])=>{
    const ref=patch(source,Math.round(u*source.width),Math.round(v*source.height));
    if(!ref)return null;
    const candidates=[],range=Math.ceil(Math.max(target.width,target.height)*.14);
    const cx=Math.round(u*target.width),cy=Math.round(v*target.height);
    for(let y=cy-range;y<=cy+range;y++)for(let x=cx-range;x<=cx+range;x++){
      const candidate=patch(target,x,y);
      if(!candidate)continue;
      let score=0;
      for(let k=0;k<ref.length;k++)score+=ref[k]*candidate[k];
      candidates.push({x,y,score});
    }
    candidates.sort((a,b)=>b.score-a.score);
    const best=candidates[0];
    if(!best||best.score<.86)return null;
    const other=candidates.find(c=>Math.hypot(c.x-best.x,c.y-best.y)>5);
    if(other&&best.score-other.score<.055)return null;
    return [best.x/target.width,best.y/target.height];
  });
  return matches.every(Boolean)?matches:null;
}


// Conservative floor proposal for wide images with a visible closed floor.
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const area=pts=>Math.abs(pts.reduce((n,p,i)=>n+cross([0,0],p,pts[(i+1)%pts.length]),0))/2;

function hull(points){
  const sorted=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const half=list=>{
    const chain=[];
    for(const p of list){
      while(chain.length>1&&cross(chain.at(-2),chain.at(-1),p)<=0)chain.pop();
      chain.push(p);
    }
    return chain.slice(0,-1);
  };
  return half(sorted).concat(half(sorted.reverse()));
}

function floorColour(pixels,i){
  const j=i*4,r=pixels[j],g=pixels[j+1],b=pixels[j+2];
  return [(r+2*g+b)/4,r-g,b-g];
}
function colourDifference(a,b){
  return Math.hypot((a[0]-b[0])*.62,a[1]-b[1],a[2]-b[2]);
}
function seedColour(pixels,w,h,x,y){
  const values=[[],[],[]];
  for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
    if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h)continue;
    floorColour(pixels,(y+dy)*w+x+dx).forEach((v,i)=>values[i].push(v));
  }
  return values.map(arr=>arr.sort((a,b)=>a-b)[arr.length>>1]);
}

function component(pixels,w,h,x,y,threshold){
  const seed=seedColour(pixels,w,h,x,y),mask=new Uint8Array(w*h);
  const queue=new Int32Array(w*h),start=y*w+x;
  if(seed[0]<42||seed[0]>235||colourDifference(seed,floorColour(pixels,start))>threshold)return null;
  queue[0]=start;mask[start]=1;
  let count=1;
  const compatible=i=>colourDifference(seed,floorColour(pixels,i))<=threshold;
  const add=(i,beyond)=>{
    if(mask[i])return;
    // Bridge a one-pixel joint only when the same floor colour continues on the other side.
    if(!compatible(i)&&(beyond===-1||!compatible(beyond)))return;
    mask[i]=1;queue[count++]=i;
  };
  for(let n=0;n<count;n++){
    const i=queue[n],col=i%w;
    if(col>0)add(i-1,col>1?i-2:-1);
    if(col<w-1)add(i+1,col<w-2?i+2:-1);
    if(i>=w)add(i-w,i>=2*w?i-2*w:-1);
    if(i<w*(h-1))add(i+w,i<w*(h-2)?i+2*w:-1);
  }
  return {mask,queue,count};
}

function orderCorners(q){
  // Start with the lower edge, left to right, so its length can be measured.
  let side=0;
  for(let i=1;i<4;i++){
    if(q[i][1]+q[(i+1)%4][1]>q[side][1]+q[(side+1)%4][1])side=i;
  }
  const ordered=[...q.slice(side),...q.slice(0,side)];
  return ordered[0][0]<=ordered[1][0]?ordered:[ordered[1],ordered[0],ordered[3],ordered[2]];
}

function boundaryScore(mask,pixels,w,h,quad){
  const centre=quad.reduce(([x,y],p)=>[x+p[0]/4,y+p[1]/4],[0,0]);
  const at=(x,y)=>Math.round(y)*w+Math.round(x);
  let minimum=1,total=0;
  for(let i=0;i<4;i++){
    const [x,y]=quad[i],[x2,y2]=quad[(i+1)%4],l=dist([x,y],[x2,y2]);
    let nx=-(y2-y)/l,ny=(x2-x)/l;
    if((centre[0]-(x+x2)/2)*nx+(centre[1]-(y+y2)/2)*ny<0){nx=-nx;ny=-ny}
    let support=0;
    for(let k=1;k<=12;k++){
      const px=x+(x2-x)*k/13,py=y+(y2-y)*k/13;
      const inner=at(px+nx*2,py+ny*2),outer=at(px-nx*3,py-ny*3);
      if(mask[inner]===1&&mask[outer]!==1&&colourDifference(floorColour(pixels,inner),floorColour(pixels,outer))>10)support++;
    }
    minimum=Math.min(minimum,support/12);total+=support/12;
  }
  return minimum>=.66?total/4:0;
}

function quadFromRegion(region,pixels,w,h){
  const {mask,queue,count}=region,total=w*h;
  if(count<total*.12||count>total*.70)return null;
  const boundary=[];
  for(let n=0;n<count;n++){
    const i=queue[n],x=i%w,y=Math.floor(i/w);
    if(x<5||x>=w-5||y<5||y>=h-5)return null;
    if(mask[i-1]!==1||mask[i+1]!==1||mask[i-w]!==1||mask[i+w]!==1)boundary.push([x,y]);
  }
  const contour=hull(boundary),quad=contour.slice();
  while(quad.length>4){
    let weakest=0,loss=Infinity;
    for(let i=0;i<quad.length;i++){
      const score=Math.abs(cross(quad[(i+quad.length-1)%quad.length],quad[i],quad[(i+1)%quad.length]));
      if(score<loss){loss=score;weakest=i}
    }
    quad.splice(weakest,1);
  }
  if(quad.length!==4||area(quad)/area(contour)<.93||count/area(contour)<.86)return null;
  const ordered=orderCorners(quad);
  const near=(ordered[0][1]+ordered[1][1])/2,far=(ordered[2][1]+ordered[3][1])/2;
  if(near<h*.70||far>h*.67||near-far<h*.18||ordered.some((p,i)=>dist(p,ordered[(i+1)%4])<Math.min(w,h)*.12))return null;
  const support=boundaryScore(mask,pixels,w,h,ordered);
  if(!support)return null;
  return {points:ordered.map(([x,y])=>[x/w,y/h]),score:support*.8+Math.min(1,count/(total*.32))*.2};
}

export function proposeFloor({pixels,width:w,height:h}){
  if(w<60||h<60||pixels.length!==w*h*4)return null;
  const proposals=[];
  for(const fractionY of [.64,.75,.85])for(const fractionX of [.35,.5,.65]){
    const x=Math.round(w*fractionX),y=Math.round(h*fractionY);
    for(const threshold of [12,23]){
      const region=component(pixels,w,h,x,y,threshold);
      if(!region)continue;
      const proposal=quadFromRegion(region,pixels,w,h);
      if(proposal)proposals.push(proposal);
    }
  }
  proposals.sort((a,b)=>b.score-a.score);
  const best=proposals[0];
  if(!best)return null;
  const rival=proposals.find(q=>q.score>=best.score-.11&&
    q.points.some((p,i)=>dist(p,best.points[i])>.09));
  return rival?null:best;
}

function aspectFromProjection(q,w,h){
  const [[x0,y0],[x1,y1],[x2,y2],[x3,y3]]=q;
  const dx1=x1-x2,dx2=x3-x2,dy1=y1-y2,dy2=y3-y2,det=dx1*dy2-dx2*dy1;
  if(Math.abs(det)<1)return null;
  const sx=x0-x1+x2-x3,sy=y0-y1+y2-y3;
  const g=(sx*dy2-dx2*sy)/det,k=(dx1*sy-sx*dy1)/det;
  if(Math.abs(g)<.08||Math.abs(k)<.08||1+g<.15||1+k<.15||1+g+k<.15)return null;
  const ax=(1+g)*x1-x0-g*w/2,ay=(1+g)*y1-y0-g*h/2;
  const bx=(1+k)*x3-x0-k*w/2,by=(1+k)*y3-y0-k*h/2;
  const focal=Math.sqrt(-(ax*bx+ay*by)/(g*k));
  const longest=Math.max(w,h);
  if(!(focal>longest*.40&&focal<longest*2.1))return null;
  const ratio=Math.hypot(ax/focal,ay/focal,g)/Math.hypot(bx/focal,by/focal,k);
  return ratio>=.25&&ratio<=4?ratio:null;
}

export function estimateRoomAspect(points,w,h){
  const q=points.map(([x,y])=>[x*w,y*h]),base=aspectFromProjection(q,w,h);
  if(!base)return null;
  for(let i=0;i<4;i++)for(let axis=0;axis<2;axis++)for(const delta of [-1.5,1.5]){
    const perturbed=q.map(p=>p.slice());perturbed[i][axis]+=delta;
    const ratio=aspectFromProjection(perturbed,w,h);
    if(!ratio||Math.abs(ratio/base-1)>.14)return null;
  }
  return base;
}

/** Locate visible ceiling/wall edge segments. These are guides, not room dimensions. */
export function proposeCeiling({pixels,width:w,height:h,boundary}){
  if(w<70||h<55||pixels.length!==w*h*4)return null;
  const gray=new Float32Array(w*h);
  for(let i=0;i<gray.length;i++)gray[i]=.2126*pixels[4*i]+.7152*pixels[4*i+1]+.0722*pixels[4*i+2];
  const edge=(x,y,slope)=>{
    if(y<5||y>=h-5||boundary&&!boundary(x,y,slope))return 0;
    let a=0,b=0;
    for(let i=-1;i<=1;i++){
      const row=Math.round(y+i*slope);
      if(row<3||row>=h-3||x+i<0||x+i>=w)return 0;
      a+=gray[(row-2)*w+x+i];b+=gray[(row+2)*w+x+i];
    }
    return Math.abs(a-b)/3;
  };
  function search({start,end,slopeMin,slopeMax,slopeStep,anchor,top,bottom,minSpan}){
    let best=null;
    const maxGap=Math.max(3,Math.round(w*.035));
    for(let slope=slopeMin;slope<=slopeMax+.0001;slope+=slopeStep)for(let y0=top;y0<=bottom;y0++){
      let left=-1,last=-1,sum=0,count=0;
      const check=()=>{
        const span=last-left+1;
        if(left<0||span<minSpan||count/span<.61)return;
        const score=sum*(count/span);
        if(!best||score>best.score)best={score,slope,y0,left,right:last,anchor};
      };
      for(let x=start;x<=end;x++){
        const contrast=edge(x,y0+(x-anchor)*slope,slope);
        if(contrast>=7){
          if(left<0)left=x;
          last=x;sum+=Math.min(contrast,23);count++;
        }else if(last>=0&&x-last>maxGap){check();left=last=-1;sum=count=0}
      }
      check();
    }
    if(!best)return null;
    const {left,right,slope,y0}=best;
    return [left,right].map(x=>[x/w,(y0+(x-anchor)*slope)/h]);
  }
  const back=search({start:Math.round(w*.15),end:Math.round(w*.85),slopeMin:-.16,slopeMax:.16,slopeStep:.015,
    anchor:w/2,top:Math.round(h*.045),bottom:Math.round(h*.38),minSpan:w*.31});
  if(!back)return null;
  const sides=[];
  for(const direction of [-1,1]){
    const [x,y]=back[direction<0?0:1],anchor=Math.round(x*w);
    const side=search({
      start:direction<0?4:anchor,end:direction<0?anchor:w-5,
      slopeMin:direction<0?.36:-2.5,slopeMax:direction<0?2.5:-.36,slopeStep:.06,
      anchor,top:Math.max(4,Math.round((y-.08)*h)),bottom:Math.min(h-5,Math.round((y+.09)*h)),
      minSpan:w*.06
    });
    if(side)sides.push(side);
  }
  return {back,sides};
}


/** First-pass dimensions. A photo can give ratios; metric scale needs a prior. */
export function estimatePhotoRoom({ceiling,floor,aspect,width,height}){
  if(!ceiling?.back&&!floor?.points)return null;
  const wallHeight=250;
  const centimetres=(value,min,max)=>Math.max(min,Math.min(max,Math.round(value/10)*10));
  let roomWidth=340;
  if(ceiling?.back){
    const [a,b]=ceiling.back;
    const visibleSpan=(.94-(a[1]+b[1])/2)*height;
    if(visibleSpan>height*.35)
      roomWidth=centimetres(Math.hypot((b[0]-a[0])*width,(b[1]-a[1])*height)/visibleSpan*wallHeight,240,650);
  }
  const useAspect=Number.isFinite(aspect)&&aspect>=.4&&aspect<=2.5;
  const depth=centimetres(useAspect?roomWidth/aspect:roomWidth*1.1,220,850);
  return {width:roomWidth,depth,height:wallHeight,depthInferred:useAspect};
}


/** Convert the ADE20K semantic map into editable-room candidates, never dimensions. */
export function semanticRoomGuides({labels,width,height},imageWidth,imageHeight,photo){
  if(!(labels instanceof Uint8Array)||labels.length!==width*height||width<8||height<8)
    throw Error('Máscara de segmentación inválida.');
  const scale=256/Math.max(imageWidth,imageHeight),w=Math.round(imageWidth*scale),h=Math.round(imageHeight*scale);
  const map=new Uint8Array(w*h),wallPixels=new Uint8ClampedArray(w*h*4),floorPixels=new Uint8ClampedArray(w*h*4);
  let ceilings=0,walls=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=y*w+x,label=labels[Math.floor(y*height/h)*width+Math.floor(x*width/w)];
    map[i]=label;
    if(label===5)ceilings++;
    if(label===0)walls++;
    const tone=label===5?120:label===0?210:165;
    wallPixels.set([tone,tone,tone,255],4*i);
    floorPixels.set(label===3?[158,113,72,255]:[216,219,224,255],4*i);
  }
  // Only vote where a ceiling-labelled patch meets a wall-labelled patch.
  const boundary=(x,y,slope)=>{
    let upper=false,lower=false;
    for(let d=2;d<=7;d++){
      const xx=Math.round(x+d*slope*.5),xu=Math.round(x-d*slope*.5);
      if(xu>=0&&xu<w&&xx>=0&&xx<w){
        upper||=map[(Math.round(y)-d)*w+xu]===5;
        lower||=map[(Math.round(y)+d)*w+xx]===0;
      }
    }
    return upper&&lower;
  };
  const source=photo?.width===w&&photo.height===h?photo.pixels:wallPixels;
  const ceiling=walls>w*h*.10&&ceilings>w*h*.035?proposeCeiling({pixels:source,width:w,height:h,boundary}):null;
  const floor=proposeFloor({pixels:floorPixels,width:w,height:h});
  const boxes=[];
  const visited=new Uint8Array(labels.length),queue=new Int32Array(labels.length);
  for(let i=0;i<labels.length;i++){
    const label=labels[i];
    if(visited[i]||(label!==8&&label!==27))continue;
    let count=1,minX=width,minY=height,maxX=0,maxY=0;
    visited[i]=1;queue[0]=i;
    const add=p=>{if(!visited[p]&&labels[p]===label){visited[p]=1;queue[count++]=p}};
    for(let n=0;n<count;n++){
      const p=queue[n],x=p%width,y=Math.floor(p/width);
      minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
      if(x>0)add(p-1);if(x<width-1)add(p+1);if(y>0)add(p-width);if(y<height-1)add(p+width);
    }
    if(count>=labels.length*.003&&maxX-minX>=3&&maxY-minY>=4&&minX>0&&maxX<width-1)
      boxes.push({label:label===8?'Posible ventana':'Posible espejo',x:minX/width,y:minY/height,w:(maxX-minX+1)/width,h:(maxY-minY+1)/height,area:count});
  }
  return {ceiling,floor,aspect:floor&&estimateRoomAspect(floor.points,w,h),width:w,height:h,
    boxes:boxes.sort((a,b)=>b.area-a.area).slice(0,8)};
}

export function preferSemanticCeiling(semantic,visual){
  if(!semantic||!visual)return semantic||visual;
  const compare=guide=>{
    const [a,b]=guide.back;
    const span=b[0]-a[0];
    return {span,slope:(b[1]-a[1])/span,centre:(a[1]+b[1])/2};
  };
  const a=compare(semantic),b=compare(visual);
  return a.span>=b.span*.78&&Math.abs(a.slope-b.slope)<.12&&Math.abs(a.centre-b.centre)<.07?semantic:visual;
}


