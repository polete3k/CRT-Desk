/* ============================================================
   NUBE (Supabase) — login, guardado en la nube y capturas.
   ------------------------------------------------------------
   · Los datos del journal se guardan en la tabla `journals` (una fila por usuario y app).
   · Las capturas se suben al bucket privado `capturas` y en el journal solo queda
     una referencia corta ("sb:ruta"). Ya no ocupan espacio en el navegador.
   · Copia local en IndexedDB: la app abre aunque no haya internet y lo que guardes
     sin conexión se sube solo cuando vuelve.
   · Varios dispositivos: cada guardado lleva un nº de versión (rev). Si otro dispositivo
     guardó antes, se avisa en vez de pisar sus cambios.
   Es genérico: app.js lo arranca con Cloud.start({...}). El swing podría usar el mismo
   archivo cambiando solo `app`.
   ============================================================ */
const Cloud=(()=>{
  const BUCKET='capturas', TABLE='journals';
  const IDB_NAME='journal-cache', IDB_STORE='kv';
  const PIXEL='data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const CFG_KEY='journal_sb_cfg';
  let sb=null, user=null, opt=null;
  let baseRev=0, dirty=false, editSeq=0, pushing=false, pushAgain=false, pushTimer=null;
  let status={kind:'',text:''}, cleaned=false, started=false;
  const urlCache=new Map(), urlPending=new Set(); let urlTimer=null;
  const uploaded=new Map();   // captura (data:) → referencia ya subida en esta sesión

  /* ---------- utilidades ---------- */
  const say=m=>{ try{ (opt&&opt.toast||console.log)(m); }catch(e){} };
  const rid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  const isRef=x=>typeof x==='string'&&x.startsWith('sb:');
  const isData=x=>typeof x==='string'&&x.startsWith('data:');
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function getCfg(){
    const c=window.CRT_CONFIG||{};
    if(c.supabaseUrl&&c.supabaseKey) return c;
    try{ return JSON.parse(localStorage.getItem(CFG_KEY)||'null'); }catch(e){ return null; }
  }

  /* ---------- IndexedDB (copia local) ---------- */
  let _idb=null;
  function idb(){
    if(_idb) return _idb;
    _idb=new Promise((res,rej)=>{
      const r=indexedDB.open(IDB_NAME,1);
      r.onupgradeneeded=()=>r.result.createObjectStore(IDB_STORE);
      r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error);
    });
    return _idb;
  }
  async function kvGet(k){
    try{ const db=await idb(); return await new Promise((res,rej)=>{ const q=db.transaction(IDB_STORE).objectStore(IDB_STORE).get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); }); }
    catch(e){ return undefined; }
  }
  async function kvSet(k,v){
    try{ const db=await idb(); await new Promise((res,rej)=>{ const tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).put(v,k); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); }); return true; }
    catch(e){ return false; }
  }
  async function kvDel(k){
    try{ const db=await idb(); await new Promise(res=>{ const tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).delete(k); tx.oncomplete=()=>res(); tx.onerror=()=>res(); }); }catch(e){}
  }
  const cacheKey=()=>`${opt.app}:${user.id}`;
  let cacheChain=Promise.resolve();
  function writeCache(){
    if(!user) return Promise.resolve();
    // en cola, para que una escritura antigua nunca pise a una más nueva
    const snap={data:JSON.parse(JSON.stringify(opt.getDB())), baseRev, dirty, at:Date.now()};
    cacheChain=cacheChain.then(()=>kvSet(cacheKey(),snap));
    return cacheChain;
  }

  /* ---------- estado (pastilla de la barra superior) ---------- */
  function setStatus(kind,text){
    status={kind,text};
    const el=document.getElementById('syncStatus');
    if(!el) return;
    const ico={ok:'☁',saving:'⟳',offline:'⚠',error:'⚠'}[kind]||'';
    el.className='sync-pill '+kind;
    el.title=text;
    el.innerHTML=`<span class="ico">${ico}</span><span class="txt">${esc(text)}</span>`;
  }

  /* ---------- pantalla de acceso ---------- */
  function gate(html){
    let g=document.getElementById('cloudGate');
    if(!g){ g=document.createElement('div'); g.id='cloudGate'; document.body.appendChild(g); }
    g.innerHTML=`<div class="gate-card"><div class="gate-brand"><div class="mark">📊</div><div><b>CRT Desk</b><div class="sub">journal privado</div></div></div>${html}</div>`;
    g.style.display='flex';
    return g;
  }
  function hideGate(){ const g=document.getElementById('cloudGate'); if(g) g.style.display='none'; }
  function showLoading(msg){ gate(`<p class="gate-msg">${esc(msg||'Cargando tu journal…')}</p>`); }
  function showError(msg,retry=true){
    gate(`<p class="gate-msg err">${esc(msg)}</p>${retry?`<button class="btn primary" style="width:100%" onclick="location.reload()">Reintentar</button>`:''}`);
  }
  function showConfig(){
    gate(`<p class="gate-msg">Primera vez en este dispositivo: pega los datos de tu proyecto de Supabase<br><span class="hint">(Supabase → Project Settings → API). Solo se pide una vez.</span></p>
      <div class="field"><label>Project URL</label><input id="cg_url" placeholder="https://xxxx.supabase.co" autocomplete="off"></div>
      <div class="field"><label>Clave publishable / anon</label><input id="cg_key" placeholder="sb_publishable_… o eyJ…" autocomplete="off"></div>
      <button class="btn primary" style="width:100%" id="cg_save">Guardar</button>`);
    document.getElementById('cg_save').onclick=()=>{
      const url=document.getElementById('cg_url').value.trim().replace(/\/+$/,'');
      const key=document.getElementById('cg_key').value.trim();
      if(!/^https:\/\/.+/.test(url)||key.length<20){ say('Revisa la URL y la clave'); return; }
      try{ localStorage.setItem(CFG_KEY,JSON.stringify({supabaseUrl:url,supabaseKey:key})); }catch(e){}
      location.reload();
    };
  }
  function showLogin(){
    gate(`<form id="cg_form" autocomplete="on">
      <div class="field"><label>Email</label><input id="cg_email" type="email" autocomplete="username" required></div>
      <div class="field"><label>Contraseña</label><input id="cg_pass" type="password" autocomplete="current-password" required></div>
      <button class="btn primary" style="width:100%" type="submit" id="cg_go">Entrar</button>
      <p class="gate-msg err" id="cg_err" style="display:none;margin-top:12px"></p>
    </form>`);
    document.getElementById('cg_form').onsubmit=async ev=>{
      ev.preventDefault();
      const btn=document.getElementById('cg_go'), err=document.getElementById('cg_err');
      btn.disabled=true; btn.textContent='Entrando…'; err.style.display='none';
      const {data,error}=await sb.auth.signInWithPassword({
        email:document.getElementById('cg_email').value.trim(),
        password:document.getElementById('cg_pass').value
      });
      if(error){
        btn.disabled=false; btn.textContent='Entrar';
        err.textContent=/invalid/i.test(error.message)?'Email o contraseña incorrectos.':'No se pudo entrar: '+error.message;
        err.style.display='';
        return;
      }
      user=data.user; afterLogin();
    };
  }

  /* ---------- arranque ---------- */
  async function start(o){
    opt=o;
    const cfg=getCfg();
    if(!window.supabase||!window.supabase.createClient){
      // la librería no cargó: casi seguro que no hay internet → abrir con la copia local
      return offlineStart();
    }
    if(!cfg) return showConfig();
    try{
      sb=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:'journal-auth'}});
    }catch(e){ return showError('La URL o la clave de Supabase no son válidas. Revisa config.js.'); }
    showLoading();
    let session=null;
    try{ session=(await sb.auth.getSession()).data.session; }catch(e){}
    if(!session) return showLogin();
    user=session.user;
    afterLogin();
  }
  async function offlineStart(){
    let last=null; try{ last=localStorage.getItem('journal_last_user'); }catch(e){}
    if(!last) return showError('Sin conexión. La primera vez necesitas internet para entrar.');
    user={id:last};
    const cache=await kvGet(cacheKey());
    if(!cache) return showError('Sin conexión y sin copia local en este dispositivo.');
    baseRev=cache.baseRev||0; dirty=!!cache.dirty;
    opt.setDB(opt.normalize(cache.data));
    hideGate(); boot();
    setStatus('offline','Sin conexión · se subirá al volver');
    say('Sin conexión: estás usando la copia local. Lo que guardes se subirá cuando abras la app con internet.');
  }

  function readLegacy(){
    try{ const raw=localStorage.getItem(opt.legacyKey); return raw?JSON.parse(raw):null; }catch(e){ return null; }
  }
  // Añade a `base` los elementos (por id) de `extra` que no estén. No borra ni pisa nada.
  function mergeById(base,extra){
    let added=0;
    Object.keys(extra||{}).forEach(k=>{
      if(!Array.isArray(extra[k])) return;
      base[k]=Array.isArray(base[k])?base[k]:[];
      const ids=new Set(base[k].map(x=>x&&x.id));
      extra[k].forEach(x=>{ if(x&&x.id&&!ids.has(x.id)){ base[k].push(x); added++; } });
    });
    return added;
  }
  const countNew=(base,extra)=>{
    const ids=new Set((base.trades||[]).map(t=>t.id));
    return (extra.trades||[]).filter(t=>!ids.has(t.id)).length;
  };

  async function afterLogin(){
    showLoading();
    try{ localStorage.setItem('journal_last_user',user.id); }catch(e){}
    const cache=await kvGet(cacheKey());
    let remote=null, remoteErr=null;
    try{
      const r=await sb.from(TABLE).select('data,rev').eq('user_id',user.id).eq('app',opt.app).maybeSingle();
      if(r.error) throw r.error;
      remote=r.data;
    }catch(e){ remoteErr=e; }

    let data=null;
    if(remoteErr){
      if(!cache) return showError('No se pudo conectar con Supabase'+(remoteErr.message?` (${remoteErr.message})`:'')+'. Si el proyecto lleva una semana sin uso, entra en supabase.com y pulsa "Restore project".');
      data=cache.data; baseRev=cache.baseRev||0; dirty=!!cache.dirty;
      setStatus('offline','Sin conexión · se subirá cuando vuelva');
    } else if(remote){
      if(cache&&cache.dirty&&cache.baseRev===remote.rev){
        data=cache.data; baseRev=remote.rev; dirty=true;            // cambios hechos sin conexión, la nube no cambió
      } else if(cache&&cache.dirty){
        const useCloud=confirm('Hay cambios en este dispositivo que no se llegaron a subir, y la nube también ha cambiado desde otro dispositivo.\n\nAceptar → quedarte con la versión de la NUBE (se pierde lo no subido de aquí).\nCancelar → subir la versión de ESTE dispositivo (sobrescribe la nube).');
        if(useCloud){ data=remote.data; baseRev=remote.rev; dirty=false; }
        else { data=cache.data; baseRev=remote.rev; dirty=true; }
      } else { data=remote.data; baseRev=remote.rev; dirty=false; }
      // ¿Este dispositivo tenía un journal antiguo (navegador) con trades que no están en la nube?
      const legacy=readLegacy();
      if(legacy){
        const n=countNew(data||{},legacy);
        if(n>0 && confirm(`Este dispositivo tiene un journal antiguo con ${n} trade(s) que no están en la nube.\n\n¿Añadirlos a tu journal de la nube? (no se borra ni se cambia nada de lo que ya hay)`)){
          mergeById(data,legacy); dirty=true;
        }
        await retireLegacy(!dirty);
      }
    } else {
      // primera vez en la nube: se sube lo que haya en este dispositivo
      const legacy=readLegacy();
      data=(cache&&cache.data)||legacy||null; baseRev=0; dirty=!!data;
      if(legacy&&!cache) say('Migrando tu journal a la nube… (las capturas tardan un poco la primera vez)');
    }
    opt.setDB(opt.normalize(data));
    hideGate();
    boot();
    await writeCache();
    if(dirty) schedulePush(0); else setStatus('ok','Guardado en la nube');
  }

  // Arranque de la app + vigilancia de conexión y cambios de otros dispositivos
  function boot(){
    if(started) return; started=true;
    opt.onReady();
    setStatus(status.kind||'ok',status.text||'Guardado en la nube');
    window.addEventListener('online',()=>{ if(dirty) schedulePush(0); else checkRemote(); });
    window.addEventListener('offline',()=>setStatus('offline',dirty?'Sin conexión · pendiente de subir':'Sin conexión'));
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') checkRemote(); });
    setInterval(()=>{ if(dirty&&!pushing) schedulePush(0); else if(document.visibilityState==='visible') checkRemote(); },45000);
    window.addEventListener('beforeunload',e=>{ if(pushing&&hasDataImages(opt.getDB())){ e.preventDefault(); e.returnValue=''; } });
  }

  // Un journal del navegador ya subido: se guarda una copia en IndexedDB y se libera el espacio
  // (en github.io el espacio se comparte con tus otros dashboards).
  async function retireLegacy(ok){
    if(!ok) return;
    const raw=(()=>{ try{ return localStorage.getItem(opt.legacyKey); }catch(e){ return null; } })();
    if(!raw) return;
    const saved=await kvSet(`legacy-backup:${opt.app}`,raw);
    if(saved){ try{ localStorage.removeItem(opt.legacyKey); }catch(e){} }
  }

  /* ---------- guardar ---------- */
  function changed(){
    editSeq++; dirty=true;
    writeCache();
    schedulePush(1200);
    if(status.kind!=='offline') setStatus('saving','Guardando…');
  }
  function schedulePush(ms){
    clearTimeout(pushTimer);
    pushTimer=setTimeout(push,ms);
  }
  async function push(){
    if(!sb||!user) return;
    if(pushing){ pushAgain=true; return; }
    pushing=true; pushAgain=false;
    try{
      await uploadPendingImages();
      const seq=editSeq;
      const payload=JSON.parse(JSON.stringify(opt.getDB()));
      if(hasDataImages(payload)){ pushAgain=true; return; }   // se añadió una captura mientras subía: otra vuelta
      const now=new Date().toISOString();
      let newRev;
      if(baseRev===0){
        const r=await sb.from(TABLE).insert({user_id:user.id,app:opt.app,data:payload,rev:1,updated_at:now}).select('rev').single();
        if(r.error){ if(r.error.code==='23505'){ await onConflict(); return; } throw r.error; }
        newRev=r.data.rev;
      } else {
        const r=await sb.from(TABLE).update({data:payload,rev:baseRev+1,updated_at:now}).eq('user_id',user.id).eq('app',opt.app).eq('rev',baseRev).select('rev');
        if(r.error) throw r.error;
        if(!r.data||!r.data.length){ await onConflict(); return; }
        newRev=r.data[0].rev;
      }
      baseRev=newRev;
      if(editSeq===seq) dirty=false;
      await writeCache();
      setStatus(dirty?'saving':'ok',dirty?'Guardando…':'Guardado en la nube');
      if(!dirty){ retireLegacy(true); if(!cleaned){ cleaned=true; setTimeout(cleanupOrphans,15000); } }
    }catch(e){
      const off=(typeof navigator!=='undefined'&&navigator.onLine===false)||/fetch|network|Failed/i.test(String(e&&e.message||e));
      setStatus(off?'offline':'error', off?'Sin conexión · pendiente de subir':'Error al guardar · se reintentará');
      if(!off) console.warn('Cloud push',e);
    }finally{
      pushing=false;
      if(pushAgain||(dirty&&status.kind==='saving')) schedulePush(800);
    }
  }
  async function onConflict(){
    let remote=null;
    try{ const r=await sb.from(TABLE).select('data,rev').eq('user_id',user.id).eq('app',opt.app).maybeSingle(); if(r.error) throw r.error; remote=r.data; }
    catch(e){ setStatus('error','Error al guardar · se reintentará'); return; }
    if(!remote){ baseRev=0; return schedulePush(0); }
    const useCloud=confirm('Este journal se ha modificado desde otro dispositivo mientras lo tenías abierto aquí.\n\nAceptar → cargar la versión de la NUBE (se pierde el último cambio hecho aquí).\nCancelar → guardar la versión de ESTE dispositivo (sobrescribe la nube).');
    if(useCloud){
      baseRev=remote.rev; dirty=false; editSeq++;
      opt.setDB(opt.normalize(remote.data));
      await writeCache(); opt.onRemoteChange();
      setStatus('ok','Guardado en la nube');
    } else {
      baseRev=remote.rev; schedulePush(0);
    }
  }
  // ¿Otro dispositivo guardó algo? → recargar (solo si aquí no hay nada pendiente ni un formulario abierto)
  let checking=false;
  async function checkRemote(){
    if(!sb||!user||pushing||checking) return;
    checking=true;
    try{
      const r=await sb.from(TABLE).select('rev').eq('user_id',user.id).eq('app',opt.app).maybeSingle();
      if(r.error||!r.data) return;
      if(r.data.rev===baseRev){ if(!dirty) setStatus('ok','Guardado en la nube'); return; }
      if(dirty){ schedulePush(0); return; }          // el push detectará el conflicto y preguntará
      if(opt.isBusy&&opt.isBusy()) return;           // formulario abierto: ya se mirará después
      const f=await sb.from(TABLE).select('data,rev').eq('user_id',user.id).eq('app',opt.app).maybeSingle();
      if(f.error||!f.data||dirty) return;
      baseRev=f.data.rev;
      opt.setDB(opt.normalize(f.data.data));
      await writeCache(); opt.onRemoteChange();
      setStatus('ok','Guardado en la nube');
      say('Actualizado con los cambios de otro dispositivo');
    }catch(e){}
    finally{ checking=false; }
  }

  /* ---------- capturas ---------- */
  function imageLists(db){
    const out=[];
    ['trades','paperTrades','noTradeDays'].forEach(k=>(db[k]||[]).forEach(x=>{ if(x&&Array.isArray(x.images)) out.push(x.images); }));
    return out;
  }
  function hasDataImages(db){ return imageLists(db).some(a=>a.some(isData)); }
  function dataURLtoBlob(d){
    const [h,b]=d.split(',');
    const mime=(h.match(/data:([^;]+)/)||[])[1]||'image/jpeg';
    const bin=atob(b); const u=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
    return new Blob([u],{type:mime});
  }
  async function uploadPendingImages(){
    const lists=imageLists(opt.getDB());
    const todo=[]; lists.forEach(a=>a.forEach((x,i)=>{ if(isData(x)) todo.push([a,i]); }));
    if(!todo.length) return;
    const done=uploaded;   // misma imagen → se sube una sola vez
    let n=0;
    const total=new Set(todo.map(([a,i])=>a[i]).filter(d=>!uploaded.has(d))).size;
    for(const [a,i] of todo){
      const d=a[i];
      if(!isData(d)) continue;
      let ref=done.get(d);
      if(!ref){
        const ext=(d.match(/data:image\/(\w+)/)||[])[1]==='png'?'png':'jpg';
        const path=`${user.id}/${opt.app}/${rid()}.${ext}`;
        setStatus('saving',`Subiendo capturas ${n+1}/${total}`);
        const blob=dataURLtoBlob(d);
        const r=await sb.storage.from(BUCKET).upload(path,blob,{contentType:blob.type,upsert:false,cacheControl:'31536000'});
        if(r.error) throw r.error;
        ref='sb:'+path; done.set(d,ref); n++;
        urlCache.set(ref,d);   // se sigue viendo al instante sin descargarla
      }
      // el array puede haberse reemplazado mientras subía: busca la imagen por contenido
      const j=a[i]===d?i:a.indexOf(d);
      if(j>=0) a[j]=ref;
      // Cualquier otra lista que tenga la misma imagen
      imageLists(opt.getDB()).forEach(b=>b.forEach((y,k)=>{ if(y===d) b[k]=ref; }));
    }
    await writeCache();
  }
  // URL para mostrar una captura (las privadas usan enlaces firmados que caducan en 24 h)
  function imgSrc(ref){
    if(!isRef(ref)) return ref||PIXEL;
    if(urlCache.has(ref)) return urlCache.get(ref);
    urlPending.add(ref);
    clearTimeout(urlTimer); urlTimer=setTimeout(fetchUrls,20);
    return PIXEL;
  }
  async function fetchUrls(){
    if(!sb||!urlPending.size) return;
    const refs=[...urlPending]; urlPending.clear();
    try{
      const r=await sb.storage.from(BUCKET).createSignedUrls(refs.map(x=>x.slice(3)),86400);
      if(r.error) throw r.error;
      (r.data||[]).forEach((x,i)=>{ if(x&&x.signedUrl) urlCache.set(refs[i],x.signedUrl); });
    }catch(e){ return; }
    document.querySelectorAll('img[data-ref]').forEach(el=>{ const u=urlCache.get(el.getAttribute('data-ref')); if(u&&el.src!==u) el.src=u; });
  }
  // Para la copia de seguridad: mete las capturas dentro del JSON (así el backup es completo)
  async function inlineImages(db){
    if(!sb) return 0;
    let fail=0;
    for(const a of imageLists(db)){
      for(let i=0;i<a.length;i++){
        if(!isRef(a[i])) continue;
        const c=urlCache.get(a[i]);
        if(isData(c)){ a[i]=c; continue; }
        try{
          const r=await sb.storage.from(BUCKET).download(a[i].slice(3));
          if(r.error) throw r.error;
          a[i]=await new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(r.data); });
        }catch(e){ fail++; }
      }
    }
    return fail;
  }
  // Borra de la nube capturas que ya no usa ningún trade (de más de 2 días, por seguridad)
  async function cleanupOrphans(){
    if(!sb||!user||dirty) return;
    try{
      const used=new Set(); imageLists(opt.getDB()).forEach(a=>a.forEach(x=>{ if(isRef(x)) used.add(x.slice(3)); }));
      const dir=`${user.id}/${opt.app}`;
      const r=await sb.storage.from(BUCKET).list(dir,{limit:1000});
      if(r.error||!r.data) return;
      const old=Date.now()-2*864e5;
      const rm=r.data.filter(f=>f.name&&f.id&&!used.has(`${dir}/${f.name}`)&&new Date(f.created_at).getTime()<old).map(f=>`${dir}/${f.name}`);
      if(rm.length) await sb.storage.from(BUCKET).remove(rm);
    }catch(e){}
  }

  async function logout(){
    if(dirty&&!confirm('Hay cambios que aún no se han subido a la nube. Si cierras sesión ahora se perderán.\n\n¿Cerrar sesión igualmente?')) return;
    try{ await kvDel(cacheKey()); }catch(e){}
    try{ localStorage.removeItem('journal_last_user'); }catch(e){}
    try{ await sb.auth.signOut(); }catch(e){}
    location.reload();
  }

  return { start, changed, imgSrc, isRef, inlineImages, logout, flush:()=>push(),
    get status(){ return status; }, get dirty(){ return dirty; },
    _test:{ mergeById, countNew, hasDataImages, get baseRev(){ return baseRev; } } };
})();
