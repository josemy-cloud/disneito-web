var SBU='https://aqfqwvzbsbjrixzgxtro.supabase.co',SBK='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxZnF3dnpic2Jqcml4emd4dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTA5MjMsImV4cCI6MjEwOTEyNjkyM30.VWRIowVOECv7ycW3Nnpz-EQNJx2izM7yx7xOxkNWVZo';
var SES,REMEMBER_SESSION;
if(typeof SES==='undefined'){SES=null;REMEMBER_SESSION=true;try{const savedLocal=localStorage.getItem('sbSes');if(savedLocal){SES=JSON.parse(savedLocal);REMEMBER_SESSION=true}else{const savedTab=sessionStorage.getItem('sbSes');if(savedTab){SES=JSON.parse(savedTab);REMEMBER_SESSION=false}}}catch(e){}
}
// Overwrite in place: removing first would make other tabs see an empty session for a moment (the editor
// reloads on that signal, which means sign-out) every time the token is renewed.
var sesSave=x=>{SES=x;try{const keep=x?(REMEMBER_SESSION?localStorage:sessionStorage):null;for(const store of[localStorage,sessionStorage])if(store!==keep)store.removeItem('sbSes');if(keep)keep.setItem('sbSes',JSON.stringify(x))}catch(e){}};
async function sbAuth(path,body,signal=AbortSignal.timeout(10000)){const r=await fetch(SBU+'/auth/v1/'+path,{signal,method:'POST',headers:{apikey:SBK,'Content-Type':'application/json'},body:JSON.stringify(body)}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error_description||j.msg||j.message||('HTTP '+r.status));return j}
// var, not const: auth.js runs twice in the editor (acceso.html, then index.html after document.write) and a
// second const declaration would abort that whole second copy with a SyntaxError.
var authPasswordMinLength=8;
var authPasswordRequirements='Mínimo 8 caracteres, 1 mayúscula, 1 número y 1 símbolo (por ejemplo, !).';
function validatedAuthEmail(value){
 const email=String(value||'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Introduce un correo electrónico válido.');
 return email;
}
function validateNewPassword(password){
 const hasSymbol=/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(password);
 if(password.length<authPasswordMinLength||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||!hasSymbol)
  throw new Error(authPasswordRequirements);
}
async function sbRecover(email){
 const redirectTo=window.location.origin+'/acceso';
 return sbAuth('recover?redirect_to='+encodeURIComponent(redirectTo),{email:validatedAuthEmail(email)});
}
var sesFrom=j=>({access_token:j.access_token,refresh_token:j.refresh_token,expires_at:j.expires_at||Math.floor(Date.now()/1e3)+(j.expires_in||3600),email:(j.user&&j.user.email)||(SES&&SES.email)});
// Tabs share the stored session but keep their own copy in memory. Supabase rotates refresh tokens and may
// revoke the whole session when a rotated one is reused, so adopt the newest stored session first and let
// only one tab refresh at a time.
function adoptStoredSession(){try{const raw=(REMEMBER_SESSION?localStorage:sessionStorage).getItem('sbSes'),s=raw&&JSON.parse(raw);if(s&&s.access_token&&s.refresh_token&&s.refresh_token!==SES.refresh_token&&s.expires_at>=SES.expires_at)SES=s}catch(e){}}
async function sbTok(signal){if(!SES)throw new Error('Inicia sesión para continuar.');if(SES.expires_at-60<Date.now()/1e3){
 const renew=async()=>{if(!SES)throw new Error('Inicia sesión para continuar.');adoptStoredSession();if(SES.expires_at-60>=Date.now()/1e3)return;const j=await sbAuth('token?grant_type=refresh_token',{refresh_token:SES.refresh_token},signal);signal?.throwIfAborted();sesSave(sesFrom(j));sessionRenewed()};
 if(navigator.locks)await navigator.locks.request('nuhio-sesion',{signal},renew);else await renew();
}if(!SES)throw new Error('Inicia sesión para continuar.');return SES.access_token}
// Keep other tabs in step: a renewal elsewhere is adopted and a sign-out elsewhere ends this tab's session.
// document.open() erases window listeners, so enterEditor registers it again and marks the window. The second
// copy of auth.js redeclares onSessionStorage as a new function object, which addEventListener would not treat as
// a duplicate: it only registers when nothing has, and through a wrapper that always calls the current function.
function onSessionStorage(e){if(e.key!=='sbSes'&&e.key!==null||!REMEMBER_SESSION)return;try{const raw=localStorage.getItem('sbSes'),s=raw&&JSON.parse(raw);if(!s){SES=null;clearTimeout(SESSION_REFRESH_TIMER);return}if(!SES||s.expires_at>=SES.expires_at){SES=s;scheduleSessionRefresh()}}catch(err){}}
function onSessionStorageEvent(e){onSessionStorage(e)}
function listenSessionStorage(){window.addEventListener('storage',onSessionStorageEvent);window.NUHIO_SESSION_LISTENER=onSessionStorageEvent}
if(typeof window!=='undefined'&&!window.NUHIO_SESSION_LISTENER)listenSessionStorage();

async function enterEditor(signal=AbortSignal.timeout(12000)){
  const token=await sbTok(signal);
  const response=await fetch('/api/editor',{
    signal,cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+token}
  });
  if(!response.ok){
    const data=await response.json().catch(()=>({}));
    throw new Error(data.error||'Cloudflare no pudo cargar el editor (HTTP '+response.status+').');
  }
  const html=await response.text();
  signal.throwIfAborted();
  if(response.headers.get('X-Disenito-Editor')!=='1'||!html.includes('id="c2"')){
    throw new Error('Cloudflare no devolvió el editor. Inténtalo de nuevo cuando termine el despliegue.');
  }
  const target=new URL('/editor',location.origin);
  target.search=location.search;
  target.searchParams.delete('_acceso');
  history.replaceState(null,'',target);
  // Render the authenticated HTML from our own Worker without a second navigation.
  document.open();
  document.write(html);
  document.close();
  // After document.open(): requests started earlier would be aborted together with the old document,
  // and window listeners registered earlier have been erased (the same function object is ignored if not).
  listenSessionStorage();
  SESSION_SYNC=syncSessionCookie().catch(()=>'error');
  // The top-bar photo is drawn by the editor's own copy of auth.js (last line of this file).
}
/* ===== Session cookie and profile photos outside the JWT =====
   The Worker protects its routes with the HttpOnly cookie __Host-disenito-session, which carries the
   Supabase access_token. Browsers drop cookies above 4096 characters, so the token must stay small:
   profile photos live in the private Storage bucket "avatars" and user_metadata only keeps avatar_path.
   Declared with var/function because auth.js runs again inside the editor after document.write. That second run
   happens while the session is already working (cookie sync, renewal timer, photo migration), so the state is only
   initialised the first time: resetting it would lose the timer handle and operations in progress. */
var SESSION_COOKIE_LIMIT=4000,AVATAR_BUCKET='avatars';
var SESSION_SYNC,SESSION_REFRESH_TIMER,AVATAR_MIGRATION,AVATAR_MIGRATION_TRIES,AVATAR_OBJECT_URL;
if(typeof AVATAR_MIGRATION_TRIES!=='number'){SESSION_SYNC=null;SESSION_REFRESH_TIMER=0;AVATAR_MIGRATION=null;AVATAR_MIGRATION_TRIES=0;AVATAR_OBJECT_URL=''}
function sessionCookieFits(token){return('__Host-disenito-session='+token).length<=SESSION_COOKIE_LIMIT}
function sessionRenewed(){SESSION_SYNC=syncSessionCookie().catch(()=>'error')}
async function syncSessionCookie(){
 if(!SES||!SES.access_token)return 'sin-sesion';
 const token=await sbTok();
 scheduleSessionRefresh();
 // Never send a token whose cookie would be discarded: shrink it by moving the photo out of the JWT.
 if(!sessionCookieFits(token)){migrateAvatar().catch(()=>{});return 'demasiado-grande'}
 const r=await fetch('/api/sesion',{method:'POST',cache:'no-store',headers:{Authorization:'Bearer '+token}});
 if(r.status===413){migrateAvatar().catch(()=>{});return 'demasiado-grande'}
 return r.ok?'ok':'error-'+r.status;
}
// Renew the token shortly before it expires; renewal also renews the cookie (Max-Age = token lifetime).
function scheduleSessionRefresh(){
 clearTimeout(SESSION_REFRESH_TIMER);
 if(!SES||!Number.isFinite(SES.expires_at))return;
 const wait=Math.min(Math.max(5000,(SES.expires_at-50)*1e3-Date.now()),2147483647);
 SESSION_REFRESH_TIMER=setTimeout(()=>{sbTok().catch(()=>{})},wait);
}
async function refreshSessionNow(){
 const j=await sbAuth('token?grant_type=refresh_token',{refresh_token:SES.refresh_token});
 sesSave(sesFrom(j));sessionRenewed();await SESSION_SYNC;return SES;
}
async function sbUser(method,body){const token=await sbTok();const r=await fetch(SBU+'/auth/v1/user',{method,headers:{apikey:SBK,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.msg||j.message||j.error_description||'No se pudo actualizar la cuenta ('+r.status+')');return j}
// Resend the current metadata with the change applied. A null value removes the key in Supabase Auth.
async function updateUserMetadata(patch){const fresh=await sbUser('GET');return sbUser('PUT',{data:{...(fresh.user_metadata||{}),...patch}})}
function avatarURL(kind,path){return SBU+'/storage/v1/object/'+(kind?kind+'/':'')+AVATAR_BUCKET+'/'+path.split('/').map(encodeURIComponent).join('/')}
async function storageFetch(method,url,body,headers={}){const token=await sbTok();return fetch(url,{method,cache:'no-store',headers:{apikey:SBK,Authorization:'Bearer '+token,...headers},body})}
async function sha256Hex(buffer){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(b=>b.toString(16).padStart(2,'0')).join('')}
// Upload, then download it again with the user's own session and compare hashes before trusting it.
async function uploadAvatarVerified(path,blob,{removeOnFailure=true}={}){
 const expected=await sha256Hex(await blob.arrayBuffer());let last=null;
 for(let attempt=0;attempt<3;attempt++){
  if(attempt)await new Promise(ok=>setTimeout(ok,400*2**attempt));
  try{
   const up=await storageFetch('POST',avatarURL('',path),blob,{'Content-Type':blob.type,'x-upsert':'true'});
   if(!up.ok){last=new Error('No se pudo subir la foto ('+up.status+').');if(up.status<500&&up.status!==429)break;continue}
   const back=await storageFetch('GET',avatarURL('authenticated',path));
   if(back.ok&&await sha256Hex(await back.arrayBuffer())===expected)return;
   last=new Error('La foto guardada no coincide con la original.');
  }catch(error){last=error}
 }
 // A unique path is referenced by nobody yet, so removing it cannot lose data. The shared migration path
 // is kept: another device may have just verified it and pointed avatar_path to it; a retry overwrites it.
 if(removeOnFailure)await storageFetch('DELETE',avatarURL('',path)).catch(()=>{});
 throw last||new Error('No se pudo subir la foto.');
}
async function setAvatar(user,blob,{migration=false}={}){
 const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[blob.type];
 if(!ext||!user||!user.id)throw new Error('Formato de foto no admitido.');
 if(blob.size>512*1024)throw new Error('La foto es demasiado grande.');
 const previous=(user.user_metadata||{}).avatar_path;
 // Retries of the migration overwrite the same object instead of leaving copies behind.
 const path=user.id+'/'+(migration?'avatar-migrado':'avatar-'+Date.now())+'.'+ext;
 await uploadAvatarVerified(path,blob,{removeOnFailure:!migration});
 // Only with a verified copy is the embedded image removed from the JWT.
 const updated=await updateUserMetadata({avatar_path:path,avatar_data:null});
 const meta=updated.user_metadata||{};
 if(meta.avatar_path!==path||meta.avatar_data)throw new Error('Supabase no confirmó el cambio de foto.');
 if(previous&&previous!==path&&previous.startsWith(user.id+'/'))await storageFetch('DELETE',avatarURL('',previous)).catch(()=>{});
 await refreshSessionNow();
 return updated;
}
function dataURLToBlob(url){
 const m=/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(url||'');if(!m)return null;
 const bin=atob(m[2].replace(/\s/g,'')),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
 return new Blob([bytes],{type:m[1]});
}
// Move a photo embedded in user_metadata.avatar_data to Storage. The original stays until the copy is verified.
function migrateAvatar(){
 if(AVATAR_MIGRATION)return AVATAR_MIGRATION;
 if(++AVATAR_MIGRATION_TRIES>3)return Promise.resolve('reintentos-agotados');
 AVATAR_MIGRATION=(async()=>{
  const user=await sbUser('GET'),meta=user.user_metadata||{};
  if(!meta.avatar_data){
   // Already migrated (for example on another device): only this token is stale.
   if(!sessionCookieFits(SES.access_token))await refreshSessionNow();
   return 'sin-foto-incrustada';
  }
  const blob=dataURLToBlob(meta.avatar_data);
  if(!blob)return 'formato-no-admitido';
  await setAvatar(user,blob,{migration:true});
  return 'migrada';
 })().finally(()=>{AVATAR_MIGRATION=null});
 return AVATAR_MIGRATION;
}
// Private photo: downloaded with the session and shown as a local blob:, never through a public URL.
async function avatarSource(meta){
 if(meta.avatar_path){
  try{
   const r=await storageFetch('GET',avatarURL('authenticated',meta.avatar_path));
   if(r.ok){if(AVATAR_OBJECT_URL)URL.revokeObjectURL(AVATAR_OBJECT_URL);AVATAR_OBJECT_URL=URL.createObjectURL(await r.blob());return AVATAR_OBJECT_URL}
  }catch(error){}
 }
 return meta.avatar_data||meta.avatar_url||'';
}
// Top-bar account button. Drawn when the editor loads (sign-in and reload), not only when «Mi cuenta» opens.
function drawAccountButton(meta,email,avatar){
 const b=document.getElementById('bAcc');if(!b)return;
 const label=(meta.full_name||email||'Mi cuenta').slice(0,18);
 if(avatar){const bi=document.createElement('img');bi.src=avatar;bi.alt='';bi.style.cssText='width:22px;height:22px;object-fit:cover;border-radius:50%;vertical-align:middle;margin-right:5px';b.replaceChildren(bi,document.createTextNode(label))}else b.textContent='👤 '+label;
}
async function initAccountButton(){
 try{
  const u=await sbUser('GET');
  if(document.readyState==='loading')await new Promise(ok=>document.addEventListener('DOMContentLoaded',ok,{once:true}));
  // «Mi cuenta» already drew the button (and owns the current blob: URL): do not replace it.
  if(document.getElementById('accountBox'))return;
  const meta=u.user_metadata||{};
  drawAccountButton(meta,u.email||(SES&&SES.email),await avatarSource(meta));
 }catch(error){}
}
async function leaveEditor(){
  const token=SES?.access_token;
  clearTimeout(SESSION_REFRESH_TIMER);
  sesSave(null);
  try{localStorage.removeItem('curProj')}catch{}
  const response=await fetch('/api/sesion',{method:'DELETE',signal:AbortSignal.timeout(9000),headers:token?{Authorization:'Bearer '+token}:{}});
  if(!response.ok)throw new Error('No se pudo cerrar la sesión. Inténtalo de nuevo.');
  location.replace('/acceso');
}
async function accountPanel({entry=false}={}){
 let box=document.getElementById('accountBox');if(box){box.remove();return}
 box=document.createElement(entry?'div':'dialog');box.id='accountBox';if(entry)box.style.cssText='position:fixed;inset:60px 20px 20px;z-index:80;background:#1a1d24;border:1px solid #556;border-radius:12px;padding:18px;overflow:auto;color:#eee;font:14px Arial;box-shadow:0 16px 50px #0009';
 if(!entry){box.className='studio-panel studio-account';box.setAttribute('aria-labelledby','studioAccountTitle');box.addEventListener('close',()=>box.remove())}
 document.body.append(box);
 const btn=(label,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='margin:5px 5px 5px 0;padding:8px 12px';b.onclick=async()=>{try{await fn()}catch(e){alert(e.message||e)}};return b};
 const field=(label,type='text',value='',autocomplete='')=>{const wrap=document.createElement('label');wrap.style.cssText='display:block;margin:10px 0;color:#bbc4d2';wrap.textContent=label;const i=document.createElement('input');i.type=type;if(autocomplete)i.autocomplete=autocomplete;i.value=value;i.style.cssText='display:block;box-sizing:border-box;width:min(100%,420px);padding:10px;margin-top:5px;background:#252c38;color:#fff;border:1px solid #566;border-radius:6px';wrap.append(i);return {wrap,input:i}};
 const passwordHint=(input,prefix='')=>{
  const small=document.createElement('small');small.id='authPasswordHint';
  small.textContent=prefix+authPasswordRequirements;
  small.style.cssText='display:block;margin:-5px 0 10px;color:#b9c4d4;font-size:11px;line-height:1.35';
  input.setAttribute('aria-describedby',small.id);return small;
 };
 const head=document.createElement('div');head.style.cssText='display:flex;justify-content:space-between;align-items:center;gap:10px';const title=document.createElement('h2');title.textContent=entry?'Accede a NuHio':'Mi cuenta';title.style.margin='0';head.append(title);if(!entry){
  head.removeAttribute('style');head.className='studio-panel-head';
  const intro=document.createElement('div');intro.innerHTML='<p class="studio-eyebrow">Estudio NuHio</p>';
  title.id='studioAccountTitle';intro.append(title);
  const sub=document.createElement('p');sub.textContent='Gestiona tu perfil y el acceso a tu cuenta.';intro.append(sub);
  const close=btn('×',()=>box.close());close.setAttribute('aria-label','Cerrar Mi cuenta');
  head.replaceChildren(intro,close);
 }box.append(head);
 const content=document.createElement('div');if(entry)content.style.cssText='max-width:720px;margin:18px auto';else content.className='studio-panel-body';box.append(content);if(!entry)box.showModal();
 const authFetch=sbUser;
 const recoveryParams=new URLSearchParams(window.location.hash.replace(/^#/,''));
 const drawPasswordReset=(token)=>{
  content.innerHTML='<p style="color:#b9c4d4">Introduce tu nueva contraseña. El enlace de recuperación solo puede utilizarse una vez.</p>';
  const p1=field('Nueva contraseña','password','','new-password');
  const p2=field('Repite la nueva contraseña','password','','new-password');
  content.append(p1.wrap,passwordHint(p1.input),p2.wrap);
  content.append(btn('Guardar nueva contraseña',async()=>{
   const password=p1.input.value;
   validateNewPassword(password);
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
  content.innerHTML='<p style="color:#b9c4d4">Inicia sesión para continuar con tus proyectos.</p>';
  const em=field('Correo electrónico','email','','username'),pw=field('Contraseña','password','','current-password');
  const form=document.createElement('form');
  form.noValidate=true;
  em.input.name='email';pw.input.name='password';
  if(entry){
   const passwordRow=document.createElement('div');
   passwordRow.className='access-password';
   const toggle=document.createElement('button');
   toggle.type='button';
   toggle.className='access-password-toggle';
   const eye='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/>';
   const setVisibility=visible=>{
    pw.input.type=visible?'text':'password';
    const label=visible?'Ocultar contraseña':'Mostrar contraseña';
    toggle.setAttribute('aria-label',label);
    toggle.title=label;
    toggle.innerHTML=eye+(visible?'<path d="m3 3 18 18"/>':'')+'</svg>';
   };
   setVisibility(false);
   toggle.onclick=()=>setVisibility(pw.input.type==='password');
   passwordRow.append(pw.wrap,toggle);
   form.append(em.wrap,passwordRow);
  }else form.append(em.wrap,pw.wrap);
  form.append(passwordHint(pw.input,'Para crear una cuenta: '));
  content.append(form);
  const rememberWrap=document.createElement('label');rememberWrap.style.cssText='display:flex;align-items:center;gap:8px;margin:10px 0 14px;color:#cbd5e1;cursor:pointer';const remember=document.createElement('input');remember.type='checkbox';remember.checked=true;remember.style.cssText='width:16px;height:16px;accent-color:#4b91d1';const rememberText=document.createElement('span');rememberText.textContent='Recordarme en este dispositivo';rememberWrap.append(remember,rememberText);form.append(rememberWrap);
  const submit=btn('Iniciar sesión',()=>{});
  submit.onclick=null;submit.type='submit';
  const status=document.createElement('p');
  status.setAttribute('role','status');
  form.append(submit,status);
  form.onsubmit=async event=>{
   event.preventDefault();
   if(submit.disabled)return;
   const email=em.input.value.trim();
   const password=pw.input.value;
   if(!email||!password){status.textContent='Introduce el correo y la contraseña.';return}
   if(!em.input.validity.valid){status.textContent='Introduce el correo electrónico de tu cuenta.';return}
   submit.disabled=true;
   let credentialsAccepted=false;
   status.textContent='Comprobando tu correo y contraseña…';
   try{
    const j=await sbAuth('token?grant_type=password',{email,password});
    if(!j.access_token||!j.refresh_token)throw new Error('El servicio no devolvió una sesión válida.');
    credentialsAccepted=true;
    REMEMBER_SESSION=remember.checked;sesSave(sesFrom(j));
    status.textContent='Cuenta verificada. Abriendo el editor…';
    if(entry)await enterEditor();else await drawProfile();
   }catch(error){
    const message=error.name==='TimeoutError'||error.name==='TypeError'
      ? 'No hubo respuesta del servicio. Inténtalo de nuevo.'
      : error.message==='Invalid login credentials'
        ? 'El correo o la contraseña no coinciden.'
        : error.message;
    status.textContent=(credentialsAccepted?'Cuenta verificada. ':'')+message;
   }finally{submit.disabled=false}
  };
  content.append(btn('¿Has olvidado tu contraseña?',async()=>{
   await sbRecover(em.input.value);
   content.innerHTML='<p style="color:#b9c4d4;line-height:1.6">Si existe una cuenta asociada a ese correo, recibirás un mensaje con un enlace para crear una contraseña nueva. Revisa también la carpeta de spam.</p>';
   content.append(btn('Volver al inicio de sesión',drawLogin));
  }));
  content.append(btn('Crear cuenta',async()=>{
   pw.input.autocomplete='new-password';
   const email=validatedAuthEmail(em.input.value),password=pw.input.value;
   validateNewPassword(password);
   await sbAuth('signup',{email,password});
   alert('Revisa tu correo para confirmar la cuenta. Después podrás iniciar sesión.');
  }));
 };
 const drawProfile=async()=>{
  if(!SES){drawLogin();return}
  content.innerHTML='<p>Consultando los datos de tu cuenta…</p>';
  let u;try{u=await authFetch('GET')}catch(e){content.innerHTML='';content.append(document.createTextNode('No se ha podido validar la sesión. '+e.message+' '),btn('Volver al inicio de sesión',leaveEditor));return}
  await catalogLoadPermissions();
  libUI();
  const meta=u.user_metadata||{},avatar=await avatarSource(meta);
  // Legacy photo embedded in the JWT: migrate it in the background; the original is kept until verified.
  if(meta.avatar_data)migrateAvatar().catch(()=>{});
  content.innerHTML='';
  const profile=document.createElement('div');profile.className='studio-profile';
  const img=document.createElement('img');img.alt='Foto de perfil';if(avatar)img.src=avatar;
  const info=document.createElement('div');const nm=document.createElement('b');nm.textContent=meta.full_name||u.email||SES.email||'Usuario';const mail=document.createElement('div');mail.textContent=u.email||SES.email||'';mail.className='studio-muted';
  const initials=document.createElement('span');initials.className='studio-initials';initials.setAttribute('aria-hidden','true');initials.textContent=nm.textContent.slice(0,2).toLocaleUpperCase();
  profile.append(avatar?img:initials,info);info.append(nm,mail);content.append(profile);
  const name=field('Nombre visible','text',meta.full_name||''),email=field('Correo electrónico','email',u.email||'','email'),pass=field('Nueva contraseña (opcional)','password','','new-password');
  const fields=document.createElement('section');fields.className='studio-account-fields';fields.innerHTML='<h3>Datos de acceso</h3>';
  fields.append(name.wrap,email.wrap,pass.wrap,passwordHint(pass.input));content.append(fields);
  const photo=document.createElement('input');photo.type='file';photo.accept='image/*';photo.style.display='none';content.append(photo);
  const photoActions=document.createElement('div');photoActions.className='studio-actions';
  photoActions.append(btn(avatar?'Cambiar foto':'Añadir foto',()=>photo.click()));
  // null removes the key in Supabase Auth (deleting it from the object is not enough: metadata is merged).
  if(avatar)photoActions.append(btn('Eliminar foto',async()=>{await updateUserMetadata({avatar_path:null,avatar_data:null,avatar_url:null});if(meta.avatar_path&&meta.avatar_path.startsWith(u.id+'/'))await storageFetch('DELETE',avatarURL('',meta.avatar_path)).catch(()=>{});await refreshSessionNow();await drawProfile()}));
  info.append(photoActions);
  photo.onchange=async()=>{const f=photo.files&&photo.files[0];if(!f)return;if(!f.type.startsWith('image/'))throw new Error('Selecciona una imagen.');const data=await new Promise((ok,ko)=>{const im=new Image(),url=URL.createObjectURL(f);im.onload=()=>{const c=document.createElement('canvas'),k=Math.min(1,256/Math.max(im.width,im.height));c.width=Math.max(1,Math.round(im.width*k));c.height=Math.max(1,Math.round(im.height*k));c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(url);c.toBlob(b=>b?ok(b):ko(new Error('No se pudo preparar la imagen.')),'image/jpeg',.78)};im.onerror=()=>ko(new Error('No se pudo leer la imagen.'));im.src=url});await setAvatar(u,data);await drawProfile()};
  const footer=document.createElement('footer');footer.className='studio-actions studio-account-footer';
  // Fresh metadata: the copy read when the panel opened may still hold a photo migrated since then.
  footer.append(btn('Guardar cambios',async()=>{const data={...((await authFetch('GET')).user_metadata||{}),full_name:name.input.value.trim()};const body={data};if(email.input.value.trim()&&email.input.value.trim()!==u.email)body.email=email.input.value.trim();if(pass.input.value){validateNewPassword(pass.input.value);body.password=pass.input.value;}if(!body.email&&!body.password&&data.full_name===(meta.full_name||'')){alert('No hay cambios que guardar.');return}await authFetch('PUT',body);if(body.email)alert('Solicitud de cambio de correo enviada. Confirma el nuevo correo si Supabase lo solicita.');else alert('Datos de la cuenta actualizados.');await drawProfile()}));
  footer.firstElementChild.className='studio-primary';
  const logout=btn('Cerrar sesión',leaveEditor);logout.className='studio-danger';footer.append(logout);
  const note=document.createElement('p');note.className='studio-muted';note.textContent='Si cambias el correo, es posible que tengas que confirmar la nueva dirección.';fields.append(note);
  content.append(footer);
  drawAccountButton(meta,u.email,avatar);
 };
 const recoveryType=recoveryParams.get('type'),recoveryToken=recoveryParams.get('access_token'),recoveryError=recoveryParams.get('error_description')||recoveryParams.get('error');
 if(recoveryType==='recovery'&&recoveryToken)drawPasswordReset(recoveryToken);
 else if(recoveryError){content.innerHTML='<p style="color:#ffb4a9;line-height:1.6">El enlace de recuperación ha caducado, ya se ha utilizado o no es válido. Solicita uno nuevo desde «¿Has olvidado tu contraseña?».</p>';content.append(btn('Volver al inicio de sesión',()=>{history.replaceState(null,document.title,window.location.pathname+window.location.search);drawLogin()}));}
 else if(entry)drawLogin();
 else await drawProfile();
}
// In the editor (its HTML includes #bAcc before this script) show the profile photo in the top bar at once:
// after a reload of /editor (only copy) and after sign-in (the editor's own copy, after document.write).
if(SES&&document.getElementById('bAcc'))initAccountButton();

