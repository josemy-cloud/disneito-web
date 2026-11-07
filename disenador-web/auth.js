const SBU='https://aqfqwvzbsbjrixzgxtro.supabase.co',SBK='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxZnF3dnpic2Jqcml4emd4dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTA5MjMsImV4cCI6MjEwOTEyNjkyM30.VWRIowVOECv7ycW3Nnpz-EQNJx2izM7yx7xOxkNWVZo';
let SES=null,REMEMBER_SESSION=true;try{const savedLocal=localStorage.getItem('sbSes');if(savedLocal){SES=JSON.parse(savedLocal);REMEMBER_SESSION=true}else{const savedTab=sessionStorage.getItem('sbSes');if(savedTab){SES=JSON.parse(savedTab);REMEMBER_SESSION=false}}}catch(e){}
const sesSave=x=>{SES=x;try{localStorage.removeItem('sbSes');sessionStorage.removeItem('sbSes');if(x)(REMEMBER_SESSION?localStorage:sessionStorage).setItem('sbSes',JSON.stringify(x))}catch(e){}};
async function sbAuth(path,body,signal=AbortSignal.timeout(10000)){const r=await fetch(SBU+'/auth/v1/'+path,{signal,method:'POST',headers:{apikey:SBK,'Content-Type':'application/json'},body:JSON.stringify(body)}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error_description||j.msg||j.message||('HTTP '+r.status));return j}
async function sbRecover(email){const address=String(email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))throw new Error('Introduce un correo electrónico válido.');const redirectTo=window.location.origin+'/acceso';const r=await fetch(SBU+'/auth/v1/recover?redirect_to='+encodeURIComponent(redirectTo),{method:'POST',headers:{apikey:SBK,'Content-Type':'application/json'},body:JSON.stringify({email:address})});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'No se pudo enviar el correo de recuperación.');return j}
const sesFrom=j=>({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:j.expires_at||Math.floor(Date.now()/1e3)+(j.expires_in||3600),email:(j.user&&j.user.email)||(SES&&SES.email)});
async function sbTok(signal){if(!SES)throw new Error('Inicia sesión para continuar.');if(SES.expires_at-60<Date.now()/1e3){const j=await sbAuth('token?grant_type=refresh_token',{refresh_token:SES.refresh_token},signal);signal?.throwIfAborted();sesSave(sesFrom(j))}return SES.access_token}

async function enterEditor(signal=AbortSignal.timeout(8000)){
  const token=await sbTok(signal);
  const response=await fetch('/api/sesion',{
    method:'POST',signal,headers:{Authorization:'Bearer '+token}
  });
  signal.throwIfAborted();
  if(!response.ok)throw new Error('No se pudo validar la sesión. Vuelve a iniciar sesión.');
  const target=new URL('/',location.origin);
  target.search=location.search;
  target.searchParams.set('_acceso','1');
  location.replace(target);
}
async function leaveEditor(){
  const token=SES?.access_token;
  sesSave(null);
  try{localStorage.removeItem('curProj')}catch{}
  const response=await fetch('/api/sesion',{method:'DELETE',headers:token?{Authorization:'Bearer '+token}:{}});
  if(!response.ok)throw new Error('No se pudo cerrar la sesión. Inténtalo de nuevo.');
  location.replace('/acceso');
}
async function accountPanel({entry=false}={}){
 let box=document.getElementById('accountBox');if(box){box.remove();return}
 box=document.createElement('div');box.id='accountBox';box.style.cssText='position:fixed;inset:60px 20px 20px;z-index:80;background:#1a1d24;border:1px solid #556;border-radius:12px;padding:18px;overflow:auto;color:#eee;font:14px Arial;box-shadow:0 16px 50px #0009';
 document.body.append(box);
 const btn=(label,fn)=>{const b=document.createElement('button');b.textContent=label;b.style.cssText='margin:5px 5px 5px 0;padding:8px 12px';b.onclick=async()=>{try{await fn()}catch(e){alert(e.message||e)}};return b};
 const field=(label,type='text',value='',autocomplete='')=>{const wrap=document.createElement('label');wrap.style.cssText='display:block;margin:10px 0;color:#bbc4d2';wrap.textContent=label;const i=document.createElement('input');i.type=type;if(autocomplete)i.autocomplete=autocomplete;i.value=value;i.style.cssText='display:block;box-sizing:border-box;width:min(100%,420px);padding:10px;margin-top:5px;background:#252c38;color:#fff;border:1px solid #566;border-radius:6px';wrap.append(i);return {wrap,input:i}};
 const head=document.createElement('div');head.style.cssText='display:flex;justify-content:space-between;align-items:center;gap:10px';const title=document.createElement('h2');title.textContent=entry?'Accede a Disenito':'Mi cuenta';title.style.margin='0';head.append(title);if(!entry)head.append(btn('✕ Cerrar',()=>box.remove()));box.append(head);
 const content=document.createElement('div');content.style.cssText='max-width:720px;margin:18px auto';box.append(content);
 const authFetch=async(method,body)=>{const token=await sbTok();const r=await fetch(SBU+'/auth/v1/user',{method,headers:{apikey:SBK,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'No se pudo actualizar la cuenta ('+r.status+')');return j};
 const recoveryParams=new URLSearchParams(window.location.hash.replace(/^#/,''));
 const drawPasswordReset=(token)=>{
  content.innerHTML='<p style="color:#b9c4d4">Introduce tu nueva contraseña. El enlace de recuperación solo puede utilizarse una vez.</p>';
  const p1=field('Nueva contraseña (mínimo 8 caracteres)','password','','new-password');
  const p2=field('Repite la nueva contraseña','password','','new-password');
  content.append(p1.wrap,p2.wrap);
  content.append(btn('Guardar nueva contraseña',async()=>{
   const password=p1.input.value;
   if(password.length<8)throw new Error('La contraseña debe tener al menos 8 caracteres.');
   if(password!==p2.input.value)throw new Error('Las contraseñas no coinciden.');
   const r=await fetch(SBU+'/auth/v1/user',{method:'PUT',headers:{apikey:SBK,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({password})});
   const j=await r.json().catch(()=>({}));
   if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'El enlace ha caducado o no es válido. Solicita uno nuevo.');
   const refreshToken=recoveryParams.get('refresh_token');
   const expiresAt=Number(recoveryParams.get('expires_at'))||Math.floor(Date.now()/1000)+Number(recoveryParams.get('expires_in')||3600);
   history.replaceState(null,document.title,window.location.pathname+window.location.search);
   if(refreshToken){REMEMBER_SESSION=true;sesSave({access_token:token,refresh_token:refreshToken,expires_at:expiresAt,email:j.email||''});if(entry)await enterEditor();else await drawProfile()}
   else{sesSave(null);drawLogin();alert('Contraseña actualizada. Ya puedes iniciar sesión con ella.')}
  }));
  content.append(btn('Cancelar y volver al inicio de sesión',()=>{history.replaceState(null,document.title,window.location.pathname+window.location.search);drawLogin()}));
 };
 const drawLogin=()=>{
  content.innerHTML='<p style="color:#b9c4d4">Inicia sesión o crea una cuenta para acceder al editor de Disenito y a tus proyectos.</p>';
  const em=field('Correo electrónico','email','','username'),pw=field('Contraseña','password','','current-password');content.append(em.wrap,pw.wrap);
  const rememberWrap=document.createElement('label');rememberWrap.style.cssText='display:flex;align-items:center;gap:8px;margin:10px 0 14px;color:#cbd5e1;cursor:pointer';const remember=document.createElement('input');remember.type='checkbox';remember.checked=true;remember.style.cssText='width:16px;height:16px;accent-color:#4b91d1';const rememberText=document.createElement('span');rememberText.textContent='Recordarme en este dispositivo';rememberWrap.append(remember,rememberText);content.append(rememberWrap);
  content.append(btn('Iniciar sesión',async()=>{if(!em.input.value||!pw.input.value)throw new Error('Introduce el correo y la contraseña.');const j=await sbAuth('token?grant_type=password',{email:em.input.value,password:pw.input.value});REMEMBER_SESSION=remember.checked;sesSave(sesFrom(j));if(entry)await enterEditor();else await drawProfile()}));
  content.append(btn('¿Has olvidado tu contraseña?',async()=>{
   await sbRecover(em.input.value);
   content.innerHTML='<p style="color:#b9c4d4;line-height:1.6">Si existe una cuenta asociada a ese correo, recibirás un mensaje con un enlace para crear una contraseña nueva. Revisa también la carpeta de spam.</p>';
   content.append(btn('Volver al inicio de sesión',drawLogin));
  }));
  content.append(btn('Crear cuenta',async()=>{pw.input.autocomplete='new-password';if(!em.input.value||pw.input.value.length<6)throw new Error('Introduce un correo y una contraseña de al menos 6 caracteres.');await sbAuth('signup',{email:em.input.value,password:pw.input.value});alert('Cuenta creada. Si se solicita confirmar el correo, revisa tu bandeja de entrada. Después podrás iniciar sesión.')}))
 };
 const drawProfile=async()=>{
  if(!SES){drawLogin();return}
  content.innerHTML='<p>Consultando los datos de tu cuenta…</p>';
  let u;try{u=await authFetch('GET')}catch(e){content.innerHTML='';content.append(document.createTextNode('No se ha podido validar la sesión. '+e.message+' '),btn('Volver al inicio de sesión',leaveEditor));return}
  await catalogLoadPermissions();
  libUI();
  const meta=u.user_metadata||{},avatar=meta.avatar_data||meta.avatar_url||'';
  content.innerHTML='';
  const profile=document.createElement('div');profile.style.cssText='display:flex;align-items:center;gap:14px;margin:12px 0 20px';
  const img=document.createElement('img');img.alt='Foto de perfil';img.src=avatar||'';img.style.cssText='width:76px;height:76px;border-radius:50%;object-fit:cover;background:#303846;border:1px solid #64748b';if(!avatar)img.style.display='none';
  const info=document.createElement('div');const nm=document.createElement('b');nm.textContent=meta.full_name||u.email||SES.email||'Usuario';const mail=document.createElement('div');mail.textContent=u.email||SES.email||'';mail.style.color='#aeb8c8';profile.append(img,info);info.append(nm,mail);content.append(profile);
  const name=field('Nombre visible','text',meta.full_name||''),email=field('Correo electrónico','email',u.email||'','email'),pass=field('Nueva contraseña (déjalo vacío si no quieres cambiarla)','password','','new-password');content.append(name.wrap,email.wrap,pass.wrap);
  const photo=document.createElement('input');photo.type='file';photo.accept='image/*';photo.style.display='none';content.append(photo);
  content.append(btn('Cambiar foto',()=>photo.click()),btn('Eliminar foto',async()=>{const m={...meta};delete m.avatar_data;delete m.avatar_url;await authFetch('PUT',{data:m});await drawProfile()}));
  photo.onchange=async()=>{const f=photo.files&&photo.files[0];if(!f)return;if(!f.type.startsWith('image/'))throw new Error('Selecciona una imagen.');const data=await new Promise((ok,ko)=>{const im=new Image(),url=URL.createObjectURL(f);im.onload=()=>{const c=document.createElement('canvas'),k=Math.min(1,256/Math.max(im.width,im.height));c.width=Math.max(1,Math.round(im.width*k));c.height=Math.max(1,Math.round(im.height*k));c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(url);ok(c.toDataURL('image/jpeg',.78))};im.onerror=()=>ko(new Error('No se pudo leer la imagen.'));im.src=url});await authFetch('PUT',{data:{...meta,avatar_data:data}});await drawProfile()};
  content.append(btn('Guardar cambios',async()=>{const data={...meta,full_name:name.input.value.trim()};const body={data};if(email.input.value.trim()&&email.input.value.trim()!==u.email)body.email=email.input.value.trim();if(pass.input.value)body.password=pass.input.value;if(!body.email&&!body.password&&data.full_name===(meta.full_name||'')){alert('No hay cambios que guardar.');return}await authFetch('PUT',body);if(body.email)alert('Solicitud de cambio de correo enviada. Confirma el nuevo correo si Supabase lo solicita.');else alert('Datos de la cuenta actualizados.');await drawProfile()}));
  const note=document.createElement('p');note.style.cssText='color:#9eabbc;font-size:12px';note.textContent='La contraseña se cambia mediante Supabase Auth. El cambio de correo puede requerir confirmación. La foto se guarda en los metadatos de tu cuenta.';content.append(note);
  content.append(btn('Cerrar sesión',leaveEditor));
  const b=document.getElementById('bAcc');if(b){const label=(meta.full_name||u.email||'Mi cuenta').slice(0,18);if(avatar){const bi=document.createElement('img');bi.src=avatar;bi.alt='';bi.style.cssText='width:22px;height:22px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:5px';b.replaceChildren(bi,document.createTextNode(label))}else b.textContent='👤 '+label}
 };
 const recoveryType=recoveryParams.get('type'),recoveryToken=recoveryParams.get('access_token'),recoveryError=recoveryParams.get('error_description')||recoveryParams.get('error');
 if(recoveryType==='recovery'&&recoveryToken)drawPasswordReset(recoveryToken);
 else if(recoveryError){content.innerHTML='<p style="color:#ffb4a9;line-height:1.6">El enlace de recuperación ha caducado, ya se ha utilizado o no es válido. Solicita uno nuevo desde «¿Has olvidado tu contraseña?».</p>';content.append(btn('Volver al inicio de sesión',()=>{history.replaceState(null,document.title,window.location.pathname+window.location.search);drawLogin()}));}
 else if(entry)drawLogin();
 else await drawProfile();
}

