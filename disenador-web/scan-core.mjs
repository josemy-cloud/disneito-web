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

