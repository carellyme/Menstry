'use strict';
/* ---------- Utilitaires dates ---------- */
const $ = s => document.querySelector(s);
const DAY = 86400000;
const toNum = s => { const [y,m,d] = s.split('-').map(Number); return Math.round(Date.UTC(y,m-1,d)/DAY); };
const toStr = n => new Date(n*DAY).toISOString().slice(0,10);
const todayNum = () => { const d = new Date(); return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())/DAY); };
const fmt = (n, o={day:'numeric', month:'short'}) => new Date(n*DAY).toLocaleDateString('fr-FR', {...o, timeZone:'UTC'});
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;

const MUCUS = [['visible','Visible'],['collante','Collante'],['fluide','Fluide']];
const MUCUS_HI = new Set(['fluide']);
/* ---------- Versions ----------
   APP_VERSION  : version du logiciel, affichée dans les réglages.
   DATA_VERSION : version du format des données, à augmenter quand la structure des données change.
   Les deux sont enregistrées dans les données du téléphone et dans chaque sauvegarde (en-tête du fichier).
   Aucun code de compatibilité pour l'instant : il sera ajouté ici le jour où le format changera,
   en comparant la version enregistrée dans les données/sauvegardes avec DATA_VERSION. */
const APP_VERSION = '1.1.3';
const DATA_VERSION = 1;
const DEFAULT_DATA = { v:1, dataVersion:DATA_VERSION, appVersion:APP_VERSION, days:{}, settings:{ cycleLen:28, periodLen:5, luteal:14, tolerance:4 }, updated:0 };
const OVUM = '<svg class="ovum" viewBox="0 0 24 24" aria-hidden="true"><use href="#ovum"/></svg>';

/* ---------- Validation des données ----------
   Toute donnée chargée (téléphone ou sauvegarde importée) est reconstruite champ par champ :
   seules les dates valides, les valeurs oui/non, les types de glaire connus et des réglages
   numériques dans des bornes raisonnables sont conservés. Le reste est ignoré. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function intIn(v, min, max, def){ const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : def; }
function sanitizeData(o){
  if (!o || typeof o !== 'object' || !o.days || typeof o.days !== 'object' || Array.isArray(o.days)) throw new Error('contenu invalide');
  const days = {}; let rejected = 0;
  for (const [k, r] of Object.entries(o.days)){
    if (!DATE_RE.test(k) || toStr(toNum(k)) !== k || !r || typeof r !== 'object'){ rejected++; continue; }
    const c = {};
    if (r.start === true){ c.start = true; c.period = true; }
    if (r.period === true) c.period = true;
    if (r.sex === true){ c.sex = true; if (r.prot === true) c.prot = true; }
    if (MUCUS.some(([v]) => v === r.mucus)) c.mucus = r.mucus;
    if (Object.keys(c).length) days[k] = c;
  }
  const s = (o.settings && typeof o.settings === 'object') ? o.settings : {}, d = DEFAULT_DATA.settings;
  return {
    v: 1, dataVersion: DATA_VERSION, appVersion: APP_VERSION, updated: Number(o.updated) || 0, days,
    settings: { cycleLen: intIn(s.cycleLen, 18, 60, d.cycleLen), periodLen: intIn(s.periodLen, 1, 12, d.periodLen),
                luteal: intIn(s.luteal, 8, 18, d.luteal), tolerance: intIn(s.tolerance, 1, 10, d.tolerance) },
    rejected
  };
}
function cleanData(o){ const c = sanitizeData(o); delete c.rejected; return c; }

/* ---------- Stockage ---------- */
function loadJSON(k, def){ try { const v = JSON.parse(localStorage.getItem(k)); return v ? {...structuredClone(def), ...v} : structuredClone(def); } catch { return structuredClone(def); } }
let data;
try { data = cleanData(loadJSON('mc.data', DEFAULT_DATA)); } catch { data = structuredClone(DEFAULT_DATA); }
let prefs = loadJSON('mc.prefs', {});
function saveData(){ data.updated = Date.now(); data.dataVersion = DATA_VERSION; data.appVersion = APP_VERSION; localStorage.setItem('mc.data', JSON.stringify(data)); }
function savePrefs(){ localStorage.setItem('mc.prefs', JSON.stringify(prefs)); }
if (navigator.storage?.persist) navigator.storage.persist().catch(()=>{});

function idb(){ return new Promise((res, rej) => { const r = indexedDB.open('menstry', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function kvGet(k){ const db = await idb(); return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function kvSet(k, v){ const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

/* ---------- Calculs du cycle ---------- */
function compute(){
  const s = data.settings, L = +s.luteal || 14;
  const starts = Object.keys(data.days).filter(k => data.days[k].start).sort().map(toNum);
  const lens = [];
  for (let i = 1; i < starts.length; i++){ const d = starts[i]-starts[i-1]; if (d >= 15 && d <= 60) lens.push(d); }
  const recent = lens.slice(-6);
  const avg = recent.length ? Math.round(mean(recent)) : (+s.cycleLen || 28);
  const plens = [];
  for (const st of starts){ let n = 0; while (n < 15 && data.days[toStr(st+n)]?.period) n++; if (n) plens.push(n); }
  const plen = plens.length ? Math.round(mean(plens.slice(-6))) : (+s.periodLen || 5);

  const fert = new Map(), predPeriod = new Set();
  const markWin = (nextStart, pred) => {
    const o = nextStart - L;
    for (let d = o-5; d <= o+2; d++){
      const prev = fert.get(d);
      if (prev && !prev.pred && pred) continue;
      fert.set(d, { ovu: d === o, pred });
    }
    return o;
  };
  // Cycles terminés : ovulation = fin de cycle (début du suivant) − 14
  for (let i = 1; i < starts.length; i++) if (starts[i]-starts[i-1] <= 60) markWin(starts[i], false);

  const info = { starts, avg, plen, nCycles: recent.length, fert, predPeriod, last:null };
  if (starts.length){
    const t = todayNum(), last = starts.at(-1), next = last + avg;
    info.last = last; info.next = next;
    info.cycleDay = t - last + 1;
    info.late = Math.max(0, t - next);
    info.ovu = markWin(next, true);
    let ns = next;
    for (let k = 0; k < 6; k++){
      if (k) markWin(ns, true);
      for (let d = 0; d < plen; d++) predPeriod.add(ns + d);
      ns += avg;
    }
  }
  return info;
}

/* ---------- Rendu ---------- */
let view = (() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; })();
let INFO = compute();

function renderSummary(){
  const i = INFO, el = $('#summary'), t = todayNum();
  if (!i.last){
    el.innerHTML = `<div class="big">Bienvenue</div><div class="phase">Toucher le premier jour des dernières règles sur le calendrier, puis cocher « Début de cycle ».</div>`;
    return;
  }
  let phase = '', cls = '';
  const f = i.fert.get(t);
  if (data.days[toStr(t)]?.period){ phase = 'Règles'; cls = 'p'; }
  else if (i.late > 0){ phase = `Règles en retard de ${i.late} jour${i.late>1?'s':''}`; cls = 'p'; }
  else if (f?.ovu){ phase = 'Ovulation estimée aujourd’hui'; cls = 'f'; }
  else if (f){ phase = 'Fenêtre fertile probable'; cls = 'f'; }
  else { const d = i.next - t; phase = d === 0 ? 'Règles prévues aujourd’hui' : `Prochaines règles dans ${d} jour${d>1?'s':''}`; }
  el.innerHTML = `
    <div class="big">Jour ${i.cycleDay}</div>
    <div class="phase ${cls}">${phase}</div>
    <div class="rows">
      <div><div class="k">Prochaines règles</div><div class="v">${fmt(i.next)}</div></div>
      <div><div class="k">Ovulation estimée</div><div class="v">${OVUM} ${fmt(i.ovu)}</div></div>
      <div><div class="k">Fenêtre fertile</div><div class="v">${fmt(i.ovu-5)} – ${fmt(i.ovu+2)}</div></div>
      <div><div class="k">Cycle moyen</div><div class="v">${i.avg} j <span style="font-weight:400;color:var(--muted);font-size:13px">${i.nCycles ? `(${i.nCycles} cycle${i.nCycles>1?'s':''})` : '(défaut)'}</span></div></div>
    </div>${regLine()}`;
}

function renderCal(){
  const { y, m } = view, i = INFO, t = todayNum();
  $('#monthLabel').textContent = new Date(Date.UTC(y, m, 1)).toLocaleDateString('fr-FR', { month:'long', year:'numeric', timeZone:'UTC' });
  const first = Math.round(Date.UTC(y, m, 1)/DAY);
  const dow = (new Date(first*DAY).getUTCDay() + 6) % 7;
  const dim = new Date(Date.UTC(y, m+1, 0)).getUTCDate();
  const cells = Math.ceil((dow + dim)/7)*7;
  const g = $('#grid');
  g.innerHTML = ['L','M','M','J','V','S','D'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let k = 0; k < cells; k++){
    const n = first - dow + k, s = toStr(n), rec = data.days[s] || {}, d = new Date(n*DAY);
    const c = ['day'];
    if (d.getUTCMonth() !== m) c.push('out');
    const f = i.fert.get(n);
    if (rec.period) c.push('period');
    else if (i.predPeriod.has(n) && n > i.last) c.push('pperiod');
    else if (f){ c.push(f.ovu ? 'ovu' : 'fertile'); if (f.pred) c.push('pred'); }
    if (rec.start) c.push('start');
    if (n === t) c.push('today');
    let b = '';
    if (rec.sex) b += rec.prot ? '<b class="heart">♡<small class="pp">p</small></b>' : '<b class="heart">♥</b>';
    if (rec.mucus) b += `<span class="drop${MUCUS_HI.has(rec.mucus) ? ' hi' : ''}">💧</span>`;
    const btn = document.createElement('button');
    btn.className = c.join(' ');
    btn.dataset.d = s;
    btn.setAttribute('aria-label', fmt(n, {weekday:'long', day:'numeric', month:'long'}));
    btn.innerHTML = `<span class="n">${d.getUTCDate()}</span>${f?.ovu && !rec.period ? OVUM : ''}${b ? `<span class="badges">${b}</span>` : ''}`;
    g.appendChild(btn);
  }
}

function renderAll(){ INFO = compute(); renderSummary(); renderCal(); }

/* ---------- Contrôle de régularité ---------- */
const n1 = v => v.toFixed(1).replace('.0','').replace('.',',');
// Analyse le cycle qui se termine au début de cycle `sNum`
function checkCycle(sNum){
  const st = Object.keys(data.days).filter(k => data.days[k].start).sort().map(toNum);
  const idx = st.indexOf(sNum); if (idx < 1) return null;
  const L = sNum - st[idx-1], tol = +data.settings.tolerance || 4, issues = [];
  if (L < 15) return { L, issues: [`Cycle très court (${L} j) : vérifier qu'il s'agit bien d'un début de règles et non d'un saignement entre deux cycles.`] };
  const prev = [];
  for (let i = Math.max(1, idx-6); i < idx; i++){ const d = st[i] - st[i-1]; if (d >= 15 && d <= 60) prev.push(d); }
  if (L < 21 || L > 35) issues.push(`Durée de ${L} j, en dehors de la plage habituelle de 21 à 35 jours.`);
  let avg = null;
  if (prev.length){ avg = mean(prev); const diff = L - avg; if (Math.abs(diff) > tol) issues.push(`${n1(Math.abs(diff))} j de ${diff > 0 ? 'plus' : 'moins'} que la moyenne des cycles précédents (${n1(avg)} j).`); }
  const rec = [...prev.slice(-5), L];
  if (rec.length >= 3){ const r = Math.max(...rec) - Math.min(...rec); if (r > 7) issues.push(`Écart de ${r} j entre le cycle le plus court et le plus long sur les ${rec.length} derniers cycles.`); }
  return { L, avg, issues };
}
function showIrregular(res, fresh){
  $('#alertTxt').textContent = fresh ? `Le cycle qui vient de se terminer a duré ${res.L} jours.` : `Le dernier cycle terminé a duré ${res.L} jours.`;
  $('#alertList').innerHTML = res.issues.map(t => `<li>${t}</li>`).join('');
  $('#alertDlg').showModal();
}
function regLine(){
  const r = INFO.last != null ? checkCycle(INFO.last) : null;
  if (!r) return '';
  return r.issues.length
    ? `<button class="reg warn" id="regWarn">⚠️ Dernier cycle irrégulier (${r.L} j) · voir</button>`
    : `<div class="reg ok">✓ Dernier cycle régulier (${r.L} j)</div>`;
}
document.addEventListener('click', e => { if (e.target.closest('#regWarn')){ const r = checkCycle(INFO.last); if (r) showIrregular(r, false); } });

/* ---------- Fiche du jour ---------- */
let sheetDay = null;
function openDay(s){ sheetDay = s; renderSheet(); $('#daySheet').showModal(); }
function renderSheet(){
  const rec = data.days[sheetDay] || {}, n = toNum(sheetDay), f = INFO.fert.get(n);
  $('#sheetTitle').textContent = fmt(n, { weekday:'long', day:'numeric', month:'long' });
  let info = '';
  if (f?.ovu) info = f.pred ? 'Ovulation estimée (prévision)' : 'Ovulation estimée (cycle terminé)';
  else if (f) info = f.pred ? 'Fenêtre fertile probable (prévision)' : 'Fenêtre fertile (cycle terminé)';
  else if (INFO.predPeriod.has(n) && n > INFO.last && !rec.period) info = 'Règles prévues';
  if (INFO.last && n >= INFO.last) info = `Jour ${n - INFO.last + 1} du cycle` + (info ? ' · ' + info : '');
  $('#sheetInfo').textContent = info || ' ';
  document.querySelectorAll('#daySheet .toggle').forEach(b => { const on = !!rec[b.dataset.k]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $('#protChips').hidden = !rec.sex;
  document.querySelectorAll('#protChips .pchip').forEach(c => { const on = !!rec.sex && (+c.dataset.p === (rec.prot ? 1 : 0)); c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); });
  $('#mucusChips').innerHTML = MUCUS.map(([v, l]) => `<button class="chip${rec.mucus === v ? ' on' : ''}" data-v="${v}" aria-pressed="${rec.mucus === v}">${l}</button>`).join('');
}
function updateDay(fn){
  const rec = { ...(data.days[sheetDay] || {}) };
  fn(rec);
  for (const k of Object.keys(rec)) if (!rec[k]) delete rec[k];
  if (Object.keys(rec).length) data.days[sheetDay] = rec; else delete data.days[sheetDay];
  saveData(); renderAll(); renderSheet(); syncSoon(true);
}
$('#daySheet').addEventListener('click', e => {
  const t = e.target.closest('.toggle'), pc = e.target.closest('.pchip'), c = !pc && e.target.closest('.chip');
  if (t){
    const k = t.dataset.k, wasStart = !!data.days[sheetDay]?.start;
    updateDay(r => {
      r[k] = !r[k];
      if (k === 'start' && r.start) r.period = true;
      if (k === 'period' && !r.period) r.start = false;
      if (k === 'sex' && !r.sex) r.prot = false;
    });
    if (k === 'start' && !wasStart && data.days[sheetDay]?.start){
      const res = checkCycle(toNum(sheetDay));
      if (res?.issues.length){ $('#daySheet').close(); showIrregular(res, true); }
      else if (res) toast(`Cycle précédent : ${res.L} jours · régulier ✓`, 3500);
    }
  } else if (pc){
    updateDay(r => { r.prot = pc.dataset.p === '1'; });
  } else if (c){
    updateDay(r => { r.mucus = r.mucus === c.dataset.v ? '' : c.dataset.v; });
  } else if (e.target === e.currentTarget) e.currentTarget.close();
});

/* ---------- Toast & mot de passe ---------- */
let toastT;
function toast(msg, ms = 2600){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }

function askPass({ title, hint = '', confirm = false }){
  return new Promise(res => {
    const dlg = $('#passDlg');
    $('#passTitle').textContent = title; $('#passHint').textContent = hint; $('#passErr').textContent = '';
    $('#pass1').value = ''; $('#pass2').value = '';
    $('#pass2').hidden = !confirm;
    $('#pass1').autocomplete = confirm ? 'new-password' : 'current-password';
    const ok = e => {
      const p1 = $('#pass1').value, p2 = $('#pass2').value;
      if (confirm && p1.length < 8){ e.preventDefault(); $('#passErr').textContent = '8 caractères minimum (une phrase de 4–5 mots est idéale).'; return; }
      if (confirm && p1 !== p2){ e.preventDefault(); $('#passErr').textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
      if (!p1){ e.preventDefault(); return; }
    };
    $('#passOk').onclick = ok;
    $('#passCancel').onclick = () => dlg.close('cancel');
    dlg.onclose = () => { const v = dlg.returnValue === 'ok' ? $('#pass1').value : null; $('#pass1').value = ''; $('#pass2').value = ''; res(v); };
    dlg.returnValue = '';
    dlg.showModal(); $('#pass1').focus();
  });
}

/* ---------- Chiffrement (Web Crypto) ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
function b64(buf){ const a = new Uint8Array(buf); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const ITER = 600000;
async function deriveKey(pass, salt){
  const base = await crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name:'PBKDF2', salt, iterations:ITER, hash:'SHA-256' }, base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
}
async function encryptWith(key, salt, obj){
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { app:'menstry', v:1, appVersion:APP_VERSION, dataVersion:DATA_VERSION, kdf:`PBKDF2-SHA256-${ITER}`, cipher:'AES-256-GCM', salt:b64(salt), iv:b64(iv), ct:b64(ct) };
}
async function decryptWith(key, p){
  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv:unb64(p.iv) }, key, unb64(p.ct));
  return JSON.parse(dec.decode(pt));
}
async function storeKey(key, salt){
  const check = await encryptWith(key, salt, 'menstry-ok');
  await kvSet('key', key); await kvSet('salt', salt); await kvSet('check', check);
  prefs.hasKey = true; savePrefs();
}
async function verifyPass(pass){
  const check = await kvGet('check'); if (!check) return false;
  try { const k = await deriveKey(pass, unb64(check.salt)); return (await decryptWith(k, check)) === 'menstry-ok'; } catch { return false; }
}
async function setupPassword(){
  const p = await askPass({ title: prefs.hasKey ? 'Nouveau mot de passe' : 'Mot de passe de chiffrement', hint: "Il chiffre les sauvegardes et n'est jamais enregistré. Il ne sera redemandé que pour une restauration sur un nouveau téléphone. En cas d'oubli, les sauvegardes sont perdues.", confirm: true });
  if (!p) return false;
  toast('Création de la clé…');
  const salt = rand(16);
  await storeKey(await deriveKey(p, salt), salt);
  toast('Mot de passe enregistré ✓');
  return true;
}
async function encryptCurrent(){
  const key = await kvGet('key'), salt = await kvGet('salt');
  if (!key) throw new Error('Aucun mot de passe de chiffrement');
  return encryptWith(key, salt, data);
}
async function decryptPayload(p){
  if (p?.app !== 'menstry' || !p.ct) throw new Error('Fichier non reconnu');
  const key = await kvGet('key'), salt = await kvGet('salt');
  if (key && salt && b64(salt) === p.salt){ try { return { obj: await decryptWith(key, p) }; } catch {} }
  for (let tries = 0; tries < 3; tries++){
    const pass = await askPass({ title:'Mot de passe de la sauvegarde', hint: tries ? 'Mot de passe incorrect, nouvel essai.' : 'Mot de passe utilisé pour cette sauvegarde.' });
    if (!pass) return null;
    toast('Déchiffrement…');
    const k = await deriveKey(pass, unb64(p.salt));
    try { return { obj: await decryptWith(k, p), key: k, salt: unb64(p.salt) }; } catch {}
  }
  throw new Error('Mot de passe incorrect');
}
async function applyImported(res){
  if (!res) return false;
  const clean = sanitizeData(res.obj), rejected = clean.rejected; delete clean.rejected;
  if (Object.keys(data.days).length && !confirm('Remplacer les données actuelles de ce téléphone par la sauvegarde ?')) return false;
  data = clean;
  saveData();
  if (res.key && !prefs.hasKey) await storeKey(res.key, res.salt);
  renderAll(); renderSettings();
  toast(rejected ? `Données restaurées ✓ (${rejected} entrée${rejected > 1 ? 's' : ''} invalide${rejected > 1 ? 's' : ''} ignorée${rejected > 1 ? 's' : ''})` : 'Données restaurées ✓', 4000);
  return true;
}

/* ---------- Export / import fichier ---------- */
$('#expBtn').onclick = async () => {
  try {
    if (!prefs.hasKey && !(await setupPassword())) return;
    const payload = await encryptCurrent();
    const name = `menstry-${toStr(todayNum())}.json`;
    const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
    const file = new File([blob], name, { type:'application/json' });
    if (navigator.canShare?.({ files:[file] })){
      try { await navigator.share({ files:[file], title:'Sauvegarde Menstry' }); return; }
      catch (e){ if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Sauvegarde chiffrée exportée ✓');
  } catch (e){ toast('Erreur : ' + e.message); }
};
$('#impBtn').onclick = () => $('#impFile').click();
$('#impFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { await applyImported(await decryptPayload(JSON.parse(await f.text()))); syncSoon(false); }
  catch (err){ toast('Import impossible : ' + err.message); }
};

/* ---------- Google Drive (appDataFolder) ---------- */
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
// Identifiant OAuth public de Menstry (non secret) : permet à tout compte Google de connecter sa sauvegarde
const GOOGLE_CLIENT_ID = '917226634270-s4gdfoc9flih0d85mequ5212f9qjsue4.apps.googleusercontent.com';
const DRIVE_FILE = 'menstry-backup.json';
let tokenClient = null, accessToken = null, tokenExp = 0, tokenWaiters = [], syncTimer = null, syncing = false;
const tokenValid = () => accessToken && Date.now() < tokenExp;

function loadScript(src){ return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`) && window.google?.accounts) return res(); const s = document.createElement('script'); s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('Chargement Google impossible (hors ligne ?)')); document.head.appendChild(s); }); }
let driveLoading = null;
function initDrive(){ return driveLoading ||= initDriveNow(); }
async function initDriveNow(){
  try {
    await loadScript('https://accounts.google.com/gsi/client');
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: SCOPE,
      callback: r => { const w = tokenWaiters; tokenWaiters = []; if (r.error){ w.forEach(x => x.rej(new Error(r.error))); return; } accessToken = r.access_token; tokenExp = Date.now() + (r.expires_in - 60)*1000; w.forEach(x => x.res(accessToken)); },
      error_callback: e => { const w = tokenWaiters; tokenWaiters = []; w.forEach(x => x.rej(new Error(e?.type === 'popup_closed' ? 'Fenêtre Google fermée' : (e?.type || 'Autorisation refusée')))); }
    });
  } catch (e){ console.warn(e); driveLoading = null; }  // nouvel essai à la prochaine ouverture des réglages
  renderCloud();
}
// Doit être appelé directement dans un geste utilisateur (clic) pour éviter le blocage du popup.
function requestToken(consent){
  return new Promise((res, rej) => {
    if (tokenValid()) return res(accessToken);
    if (!tokenClient) return rej(new Error('Google pas encore chargé, nouvel essai dans un instant'));
    tokenWaiters.push({ res, rej });
    tokenClient.requestAccessToken({ prompt: consent ? 'consent' : '' });
  });
}
async function gfetch(url, opts = {}){
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) } });
  if (r.status === 401){ accessToken = null; throw new Error('Session Google expirée'); }
  if (!r.ok && r.status !== 404) throw new Error('Drive : erreur ' + r.status);
  return r;
}
async function driveListAll(){
  const q = encodeURIComponent(`name='${DRIVE_FILE}'`);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`);
  return (await r.json()).files || [];
}
async function driveFind(){
  const q = encodeURIComponent(`name='${DRIVE_FILE}'`);
  const r = await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  const j = await r.json(); return j.files?.[0] || null;
}
async function driveUpload(){
  if (syncing) return; syncing = true; renderCloud();
  try {
    const body = JSON.stringify(await encryptCurrent());
    let id = prefs.driveFileId;
    if (id){
      const r = await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body });
      if (r.status === 404) id = null;
    }
    if (!id){
      const ex = await driveFind();
      if (ex){ id = ex.id; await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body }); }
      else {
        const bd = 'mcb' + Math.random().toString(36).slice(2);
        const mp = `--${bd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: DRIVE_FILE, parents:['appDataFolder'] })}\r\n--${bd}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${bd}--`;
        const r = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method:'POST', headers:{ 'Content-Type':`multipart/related; boundary=${bd}` }, body: mp });
        id = (await r.json()).id;
      }
    }
    prefs.driveFileId = id; prefs.dirty = false; prefs.lastSync = Date.now(); prefs.syncErr = ''; savePrefs();
  } catch (e){ prefs.syncErr = e.message; savePrefs(); throw e; }
  finally { syncing = false; renderCloud(); if ($('#setDlg').open) renderSettings(); }
}
function scheduleUpload(){ clearTimeout(syncTimer); syncTimer = setTimeout(() => driveUpload().catch(e => console.warn(e)), 1200); }
function syncSoon(gesture){
  if (!prefs.driveOn || !prefs.hasKey) return;
  prefs.dirty = true; savePrefs(); renderCloud();
  if (tokenValid()) return scheduleUpload();
  if (gesture && tokenClient) requestToken(false).then(scheduleUpload).catch(e => { prefs.syncErr = e.message; savePrefs(); renderCloud(); });
}
function renderCloud(){
  const b = $('#cloudBtn');
  b.hidden = !prefs.driveOn;
  b.classList.toggle('err', !!(prefs.dirty && prefs.syncErr));
  b.textContent = syncing ? '☁️ …' : prefs.dirty ? (prefs.syncErr ? '☁️ !' : '☁️ ↑') : '☁️ ✓';
  b.title = syncing ? 'Synchronisation…' : prefs.dirty ? 'Toucher pour synchroniser' : 'Sauvegardé sur Drive';
}
$('#cloudBtn').onclick = () => {
  if (!prefs.dirty){ toast(prefs.lastSync ? `Sauvegardé sur Drive le ${new Date(prefs.lastSync).toLocaleString('fr-FR')}` : 'Drive connecté'); return; }
  requestToken(false).then(driveUpload).then(() => toast('Sauvegardé sur Drive ✓')).catch(e => toast('Drive : ' + e.message));
};

/* ---------- Empreinte / Face ID (WebAuthn) ---------- */
async function registerBio(){
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rand(32), rp: { name:'Menstry' },
    user: { id: rand(16), name:'menstry', displayName:'Menstry' },
    pubKeyCredParams: [{ type:'public-key', alg:-7 }, { type:'public-key', alg:-257 }],
    authenticatorSelection: { authenticatorAttachment:'platform', userVerification:'required', residentKey:'discouraged' },
    timeout: 60000, attestation:'none'
  }});
  prefs.credId = b64(cred.rawId); savePrefs();
}
async function verifyBio(){
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), allowCredentials: [{ type:'public-key', id: unb64(prefs.credId), transports:['internal'] }],
    userVerification:'required', timeout: 60000
  }});
  const flags = new Uint8Array(a.response.authenticatorData)[32];
  return !!(flags & 0x04); // bit UV : l'utilisatrice a bien été vérifiée
}
let hiddenAt = 0;
const LOCK_DELAYS = [1, 5, 15, 30];
const lockDelayMin = () => LOCK_DELAYS.includes(+prefs.lockDelay) ? +prefs.lockDelay : 5;  // 5 min par défaut
function lockNow(){
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  document.body.classList.add('locked'); $('#lock').hidden = false; $('#lockErr').textContent = '';
  $('#unlockPass').hidden = !prefs.hasKey;
}
function unlockUI(){ document.body.classList.remove('locked'); $('#lock').hidden = true; renderAll(); }
async function tryBio(silent){
  try { if (await verifyBio()) unlockUI(); else $('#lockErr').textContent = 'Vérification non confirmée.'; }
  catch (e){ if (!silent) $('#lockErr').textContent = e.name === 'NotAllowedError' ? 'Annulé ou non reconnu. Toucher Déverrouiller pour réessayer.' : 'Erreur : ' + e.message; }
}
$('#unlockBtn').onclick = () => tryBio(false);
$('#unlockPass').onclick = async () => {
  const p = await askPass({ title:'Mot de passe', hint:'Mot de passe de chiffrement.' });
  if (!p) return;
  $('#lockErr').textContent = 'Vérification…';
  if (await verifyPass(p)) unlockUI(); else $('#lockErr').textContent = 'Mot de passe incorrect.';
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden){ hiddenAt = Date.now(); return; }
  if (document.body.classList.contains('locked')) return;
  if (prefs.lockOn && hiddenAt && Date.now() - hiddenAt > lockDelayMin() * 60000){ lockNow(); tryBio(true); }
  else renderAll();
});

/* ---------- Réglages ---------- */
function renderSettings(){
  const s = data.settings;
  $('#sCycle').value = s.cycleLen; $('#sPeriod').value = s.periodLen; $('#sLuteal').value = s.luteal; $('#sTol').value = s.tolerance;
  $('#avgInfo').textContent = INFO.nCycles ? `Moyenne calculée : ${INFO.avg} j sur ${INFO.nCycles} cycle(s) — utilisée en priorité` : 'Utilisée tant qu’aucun cycle complet n’est noté (2 débuts de cycle)';
  $('#keyInfo').textContent = prefs.hasKey ? 'Configuré · clé gardée dans ce téléphone' : 'Nécessaire pour les sauvegardes';
  $('#keyBtn').textContent = prefs.hasKey ? 'Changer' : 'Configurer';
  $('#bioSw').checked = !!prefs.lockOn;
  $('#lockDelay').value = String(lockDelayMin()); $('#lockDelayRow').hidden = !prefs.lockOn;
  $('#verInfo').textContent = `Menstry version ${APP_VERSION} · format des données ${DATA_VERSION}`;
  const on = !!prefs.driveOn;
  $('#driveConnect').hidden = on; $('#driveNow').hidden = !on; $('#driveRestore').hidden = !on; $('#driveOff').hidden = !on; $('#driveDelete').hidden = !on;
  $('#driveConnect').disabled = !tokenClient;
  $('#driveInfo').textContent = !prefs.hasKey ? 'Configurer d’abord le mot de passe de chiffrement.'
    : on ? (prefs.lastSync ? `Dernière sauvegarde : ${new Date(prefs.lastSync).toLocaleString('fr-FR')}` : 'Connecté') + (prefs.syncErr && prefs.dirty ? ` · Erreur : ${prefs.syncErr}` : '')
    : !tokenClient ? 'Connexion à Google… (connexion internet nécessaire)'
    : 'Sauvegarde automatique et chiffrée dans un dossier caché du Google Drive du compte choisi.';
}
$('#setBtn').onclick = () => { renderSettings(); $('#setDlg').showModal(); initDrive().then(() => { if ($('#setDlg').open) renderSettings(); }); };
for (const [id, k] of [['#sCycle','cycleLen'], ['#sPeriod','periodLen'], ['#sLuteal','luteal'], ['#sTol','tolerance']]){
  $(id).onchange = e => { const el = e.target, v = intIn(parseInt(el.value, 10), +el.min, +el.max, null); if (v === null){ toast(`Valeur entre ${el.min} et ${el.max}`); return renderSettings(); } data.settings[k] = v; saveData(); renderAll(); renderSettings(); syncSoon(false); };
}
$('#keyBtn').onclick = async () => {
  if (prefs.hasKey){
    const old = await askPass({ title:'Mot de passe actuel', hint:'Pour confirmer le changement.' });
    if (!old) return;
    if (!(await verifyPass(old))) return toast('Mot de passe incorrect');
  }
  if (await setupPassword()){ renderSettings(); syncSoon(false); }
};
$('#bioSw').onchange = async e => {
  if (e.target.checked){
    if (!window.PublicKeyCredential || !window.isSecureContext){ e.target.checked = false; return toast('Non disponible : l’app doit être ouverte en https'); }
    if (!prefs.hasKey){
      e.target.checked = false;
      toast('Un mot de passe de secours est d’abord nécessaire', 3500);
      if (!(await setupPassword())) return;
      renderSettings(); toast('Mot de passe enregistré. Réactiver le verrouillage.', 3500); return;
    }
    try { await registerBio(); prefs.lockOn = true; savePrefs(); renderSettings(); toast('Verrouillage activé ✓'); }
    catch (err){ e.target.checked = false; toast(err.name === 'NotAllowedError' ? 'Annulé' : 'Empreinte indisponible : ' + err.message); }
  } else {
    try { if (!(await verifyBio())) throw new Error(); prefs.lockOn = false; delete prefs.credId; savePrefs(); renderSettings(); toast('Verrouillage désactivé'); }
    catch { e.target.checked = true; toast('Vérification requise pour désactiver'); }
  }
};
$('#lockDelay').onchange = e => { prefs.lockDelay = +e.target.value; savePrefs(); toast(`Verrouillage après ${prefs.lockDelay} min hors de l’application`); };
$('#driveConnect').onclick = () => {
  if (!prefs.hasKey) return toast('Configurer d’abord le mot de passe de chiffrement');
  requestToken(true).then(async () => {
    prefs.driveOn = true; savePrefs();
    const ex = await driveFind();
    if (ex){
      prefs.driveFileId = ex.id; savePrefs();
      if (!Object.keys(data.days).length && confirm('Une sauvegarde existe déjà sur Google Drive. La restaurer maintenant ?')){
        const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${ex.id}?alt=media`);
        await applyImported(await decryptPayload(await r.json()));
        prefs.dirty = false; prefs.lastSync = Date.now(); savePrefs();
        renderSettings(); renderCloud(); return;
      }
    }
    await driveUpload(); toast('Drive connecté ✓');
  }).catch(e => toast('Drive : ' + e.message)).finally(() => { renderSettings(); renderCloud(); });
};
$('#driveNow').onclick = () => { requestToken(false).then(driveUpload).then(() => toast('Sauvegardé sur Drive ✓')).catch(e => toast('Drive : ' + e.message)); };
$('#driveRestore').onclick = () => {
  requestToken(false).then(async () => {
    const ex = await driveFind(); if (!ex) return toast('Aucune sauvegarde sur Drive');
    const r = await gfetch(`https://www.googleapis.com/drive/v3/files/${ex.id}?alt=media`);
    if (await applyImported(await decryptPayload(await r.json()))){ prefs.dirty = false; prefs.driveFileId = ex.id; savePrefs(); renderCloud(); }
  }).catch(e => toast('Restauration impossible : ' + e.message));
};
$('#driveOff').onclick = () => {
  if (!confirm('Désactiver la sauvegarde Drive ? (la sauvegarde existante reste sur Google Drive)')) return;
  prefs.driveOn = false; prefs.dirty = false; savePrefs();
  if (accessToken && window.google?.accounts) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null; renderSettings(); renderCloud();
};
$('#driveDelete').onclick = () => {
  requestToken(false).then(async () => {
    if (!confirm('Supprimer la sauvegarde de Google Drive ?\n\nLa sauvegarde automatique sera aussi désactivée. Les données de ce téléphone ne sont pas touchées.')) return;
    clearTimeout(syncTimer);
    const files = await driveListAll();
    for (const f of files) await gfetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method:'DELETE' });
    prefs.driveOn = false; prefs.dirty = false; prefs.driveFileId = null; prefs.lastSync = null; prefs.syncErr = ''; savePrefs();
    if (accessToken && window.google?.accounts) google.accounts.oauth2.revoke(accessToken, () => {});
    accessToken = null; renderSettings(); renderCloud();
    toast(files.length ? 'Sauvegarde Drive supprimée ✓' : 'Aucune sauvegarde sur Drive. Synchronisation désactivée.');
  }).catch(e => toast('Suppression impossible : ' + e.message));
};
$('#wipeBtn').onclick = async () => {
  if (!confirm('Effacer TOUTES les données de ce téléphone ?')) return;
  if (!confirm('Vraiment ? Cette action est irréversible (les sauvegardes Drive/fichier ne sont pas touchées).')) return;
  localStorage.clear(); indexedDB.deleteDatabase('menstry'); location.reload();
};

/* ---------- Statistiques ---------- */
let statsRange = 6;
const dm = n => { const d = new Date(n*DAY); return `${d.getUTCDate()}/${d.getUTCMonth()+1}`; };
function cycleStats(){
  const L = +data.settings.luteal || 14, st = INFO.starts, out = [];
  for (let i = 0; i < st.length - 1; i++){
    const s = st[i], e = st[i+1], len = e - s;
    if (len < 15 || len > 60) continue;
    let p = 0; while (p < 15 && data.days[toStr(s+p)]?.period) p++;
    const ovu = e - L; let sex = 0, sexF = 0, unp = 0, unpF = 0;
    for (let d = s; d < e; d++){ const r = data.days[toStr(d)]; if (r?.sex){ const f = d >= ovu-5 && d <= ovu+2; sex++; if (f) sexF++; if (!r.prot){ unp++; if (f) unpF++; } } }
    out.push({ start:s, end:e, len, p, ovuDay: ovu - s + 1, sex, sexF, unp, unpF });
  }
  return out;
}
function niceStep(raw){ const p = Math.pow(10, Math.floor(Math.log10(raw))); const f = raw/p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }

// Graphique SVG mono-série (ligne ou barres) avec réticule + info-bulle au toucher
function chart(pts, { type = 'line', color, avg = null, zero = false }){
  const W = 340, H = 170, ml = 28, mr = 10, mt = 16, mb = 22, iw = W-ml-mr, ih = H-mt-mb, n = pts.length;
  const ys = pts.map(p => p.y);
  let lo = zero ? 0 : Math.min(...ys, avg ?? Infinity) - 2, hi = Math.max(...ys, avg ?? -Infinity) + 2;
  const step = niceStep(Math.max(1, (hi - lo)/4));
  lo = Math.max(0, Math.floor(lo/step)*step); hi = Math.ceil(hi/step)*step; if (hi === lo) hi = lo + step;
  const X = type === 'bar' ? i => ml + iw*(i+0.5)/n : i => n === 1 ? ml + iw/2 : ml + 10 + (iw-20)*i/(n-1);
  const Y = v => mt + ih*(1 - (v-lo)/(hi-lo));
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) g += `<line x1="${ml}" x2="${W-mr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#efe7e3" stroke-width="1"/><text x="${ml-6}" y="${Y(v)+3}" text-anchor="end">${v}</text>`;
  const k = Math.ceil(n/6);
  pts.forEach((p, i) => { if ((n-1-i) % k === 0) g += `<text x="${X(i)}" y="${H-6}" text-anchor="middle">${p.x}</text>`; });
  if (avg != null) g += `<line x1="${ml}" x2="${W-mr}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="#8a7f83" stroke-width="1.2" stroke-dasharray="4 4"/>`;
  let m = '';
  if (type === 'bar'){
    const bw = Math.min(22, iw/n*0.62), base = Y(lo);
    pts.forEach((p, i) => { const x = X(i) - bw/2, y = Y(p.y), r = Math.min(4, (base-y)/2, bw/2);
      m += `<path class="mk" d="M${x},${base} V${y+r} Q${x},${y} ${x+r},${y} H${x+bw-r} Q${x+bw},${y} ${x+bw},${y+r} V${base} Z" fill="${color}"/>`; });
  } else {
    m += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i)},${Y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach((p, i) => { m += `<circle class="mk" cx="${X(i)}" cy="${Y(p.y)}" r="4" fill="${color}" stroke="#fff" stroke-width="2"/>`; });
  }
  const last = pts.at(-1);
  m += `<text class="lab" x="${X(n-1)}" y="${Y(last.y) - 9}" text-anchor="middle">${last.y}</text>`;
  const xs = pts.map((_, i) => +X(i).toFixed(1));
  return `<div class="chart" data-xs="${xs.join(',')}" data-tips="${encodeURIComponent(JSON.stringify(pts.map(p => p.tip)))}">
    <svg viewBox="0 0 ${W} ${H}" role="img">${g}<line class="xh" y1="${mt}" y2="${H-mb}" stroke="#2b2326" stroke-width="1" opacity="0"/>${m}<rect x="${ml}" y="0" width="${iw}" height="${H}" fill="transparent"/></svg>
    <div class="ctip"></div></div>`;
}
function wireCharts(root){
  root.querySelectorAll('.chart').forEach(c => {
    const xs = c.dataset.xs.split(',').map(Number), tips = JSON.parse(decodeURIComponent(c.dataset.tips));
    const svg = c.querySelector('svg'), tip = c.querySelector('.ctip'), xh = svg.querySelector('.xh'), mks = svg.querySelectorAll('.mk');
    const show = e => {
      const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * 340 / r.width;
      let i = 0; xs.forEach((v, j) => { if (Math.abs(v - x) < Math.abs(xs[i] - x)) i = j; });
      xh.setAttribute('x1', xs[i]); xh.setAttribute('x2', xs[i]); xh.setAttribute('opacity', .25);
      mks.forEach((mk, j) => { mk.style.opacity = j === i ? 1 : .55; if (mk.tagName === 'circle') mk.setAttribute('r', j === i ? 6 : 4); });
      tip.innerHTML = tips[i]; tip.classList.add('show');
      const px = xs[i] / 340 * r.width, tw = tip.offsetWidth;
      tip.style.left = Math.min(r.width - tw/2, Math.max(tw/2, px)) + 'px';
      tip.style.top = '-30px';
    };
    const hide = () => { tip.classList.remove('show'); xh.setAttribute('opacity', 0); mks.forEach(mk => { mk.style.opacity = 1; if (mk.tagName === 'circle') mk.setAttribute('r', 4); }); };
    svg.addEventListener('pointerdown', show); svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
    c._hide = hide;
  });
}
document.addEventListener('pointerdown', e => { document.querySelectorAll('.chart').forEach(c => { if (!c.contains(e.target)) c._hide?.(); }); });
function overview(cyc){
  const L = +data.settings.luteal || 14, rows = cyc.slice(-8).map(c => ({ s: c.start, e: c.end, len: c.len, cur: false }));
  if (INFO.last != null) rows.push({ s: INFO.last, e: INFO.next, len: Math.max(INFO.avg, todayNum() - INFO.last + 1), cur: true });
  const max = Math.max(...rows.map(r => r.len));
  return rows.reverse().map(r => {
    const ovu = r.e - L, t = todayNum();
    let cells = '';
    for (let d = 0; d < r.len; d++){
      const n = r.s + d, rec = data.days[toStr(n)] || {}, c = [];
      if (rec.period) c.push('p'); else if (n === ovu) c.push('o'); else if (n >= ovu-5 && n <= ovu+2) c.push('f');
      if (r.cur && n > t) c.push('fut');
      if (rec.sex) c.push(rec.prot ? 's sp' : 's'); if (rec.mucus) c.push('m');
      cells += `<i class="${c.join(' ')}" title="${fmt(n)}"></i>`;
    }
    return `<div class="ov-row"><div class="ov-lab"><b>${fmt(r.s)}</b><br>${r.cur ? 'en cours' : r.len + ' j'}</div><div class="ov-cells" style="grid-template-columns:repeat(${max},1fr)">${cells}</div></div>`;
  }).join('');
}
function renderStats(){
  document.querySelectorAll('#rangeChips .chip').forEach(b => b.classList.toggle('on', +b.dataset.r === statsRange));
  const all = cycleStats(), cyc = statsRange ? all.slice(-statsRange) : all, body = $('#statsBody');
  if (!cyc.length){
    body.innerHTML = `<div class="empty">📈<br><br>Les statistiques apparaissent dès que deux débuts de cycle sont marqués (un cycle complet).</div>`;
    return;
  }
  const lens = cyc.map(c => c.len), avg = mean(lens);
  const sd = Math.sqrt(mean(lens.map(l => (l-avg)**2)));
  const reg = cyc.length < 3 ? '—' : sd <= 2 ? 'Très régulier' : sd <= 4 ? 'Régulier' : 'Irrégulier';
  const ps = cyc.filter(c => c.p).map(c => c.p);
  const sexT = cyc.reduce((a, c) => a + c.sex, 0), sexF = cyc.reduce((a, c) => a + c.sexF, 0), unpF = cyc.reduce((a, c) => a + c.unpF, 0);
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="s">Cycle moyen</div><div class="v">${n1(avg)} j</div></div>
      <div class="tile"><div class="s">Min – max</div><div class="v">${Math.min(...lens)}–${Math.max(...lens)} j</div></div>
      <div class="tile"><div class="s">Régularité</div><div class="v" style="font-size:15px">${reg}</div>${cyc.length >= 3 ? `<div class="s">± ${n1(sd)} j</div>` : ''}</div>
      <div class="tile"><div class="s">Règles moy.</div><div class="v">${ps.length ? n1(mean(ps)) + ' j' : '—'}</div></div>
      <div class="tile"><div class="s">Ovulation moy.</div><div class="v">J${Math.round(mean(cyc.map(c => c.ovuDay)))}</div></div>
      <div class="tile"><div class="s">Cycles</div><div class="v">${cyc.length}</div></div>
    </div>
    <section class="card"><p class="ch-title">Durée des cycles</p><p class="ch-sub">En jours · la ligne en pointillé indique la moyenne (${n1(avg)} j) · toucher un point pour le détail</p>
      ${chart(cyc.map(c => ({ x: dm(c.start), y: c.len, tip: `Cycle du ${fmt(c.start)} : <b>${c.len} j</b>` })), { color: '#b8405e', avg })}</section>
    <section class="card"><p class="ch-title">Jour d'ovulation estimé</p><p class="ch-sub">Jour du cycle, estimé ${+data.settings.luteal || 14} jours avant la fin du cycle</p>
      ${chart(cyc.map(c => ({ x: dm(c.start), y: c.ovuDay, tip: `Cycle du ${fmt(c.start)} : ovulation <b>J${c.ovuDay}</b> (${fmt(c.end - (+data.settings.luteal||14))})` })), { color: '#2e9e66' })}</section>
    ${ps.length ? `<section class="card"><p class="ch-title">Durée des règles</p><p class="ch-sub">En jours</p>
      ${chart(cyc.map(c => ({ x: dm(c.start), y: c.p, tip: `Cycle du ${fmt(c.start)} : <b>${c.p} j</b> de règles` })), { type: 'bar', color: '#d94862', zero: true })}</section>` : ''}
    ${sexT ? `<section class="card"><p class="ch-title">Rapports par cycle</p><p class="ch-sub">${sexF} sur ${sexT} pendant la fenêtre fertile estimée, dont ${unpF} non protégé${unpF > 1 ? 's' : ''}</p>
      ${chart(cyc.map(c => ({ x: dm(c.start), y: c.sex, tip: `Cycle du ${fmt(c.start)} : <b>${c.sex}</b> rapport${c.sex > 1 ? 's' : ''} (${c.unp} non protégé${c.unp > 1 ? 's' : ''}), dont ${c.sexF} en fenêtre fertile` })), { type: 'bar', color: '#c2185b', zero: true })}</section>` : ''}
    <section class="card"><p class="ch-title">Mes cycles</p><p class="ch-sub">Un rang par cycle, un carré par jour (le plus récent en haut)</p>
      ${overview(all)}
      <div class="ov-legend">
        <span><i style="background:var(--period)"></i>Règles</span><span><i style="background:var(--fert)"></i>Fenêtre fertile</span>
        <span><i style="background:var(--ovu)"></i>Ovulation</span><span><i style="background:#f1ebe8"><b style="position:absolute;left:3px;top:3px;width:6px;height:6px;border-radius:50%;background:#c2185b"></b></i>Non protégé</span><span><i style="background:#f1ebe8"><b style="position:absolute;left:3px;top:3px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:inset 0 0 0 1.5px #c2185b"></b></i>Protégé</span>
        <span><i style="background:#f1ebe8;box-shadow:inset 0 -3px 0 var(--mucus)"></i>Glaire</span>
      </div></section>
    <details class="tbl"><summary>Voir en tableau</summary>
      <table><tr><th>Début</th><th>Durée</th><th>Règles</th><th>Ovulation</th><th>Rapports</th></tr>
      ${cyc.slice().reverse().map(c => `<tr><td>${fmt(c.start, {day:'numeric', month:'short', year:'2-digit'})}</td><td>${c.len} j</td><td>${c.p || '—'} j</td><td>J${c.ovuDay}</td><td>${c.sex}${c.sex ? ` <small style="color:var(--muted)">(${c.unp} non prot.)</small>` : ''}</td></tr>`).join('')}
      </table></details>`;
  wireCharts(body);
}
$('#statsBtn').onclick = () => { renderStats(); $('#statsDlg').showModal(); };
$('#rangeChips').onclick = e => { const b = e.target.closest('.chip'); if (!b) return; statsRange = +b.dataset.r; renderStats(); };

/* ---------- Navigation ---------- */
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
$('#setDlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#grid').onclick = e => { const b = e.target.closest('.day'); if (b) openDay(b.dataset.d); };
$('#prevM').onclick = () => { view.m--; if (view.m < 0){ view.m = 11; view.y--; } renderCal(); };
$('#nextM').onclick = () => { view.m++; if (view.m > 11){ view.m = 0; view.y++; } renderCal(); };
$('#todayBtn').onclick = () => { const d = new Date(); view = { y: d.getFullYear(), m: d.getMonth() }; renderCal(); openDay(toStr(todayNum())); };
let tx = null;
$('#grid').addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive:true });
$('#grid').addEventListener('touchend', e => { if (tx === null) return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 60) (dx < 0 ? $('#nextM') : $('#prevM')).click(); });

/* ---------- Démarrage ---------- */
if (prefs.lockOn && prefs.credId){ lockNow(); tryBio(true); } else unlockUI();
renderCloud();
if (prefs.driveOn) initDrive();
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
