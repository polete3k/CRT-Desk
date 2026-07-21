/* ============================================================
   CRT Desk — Futures Prop Tracker
   Motor de métricas + UI. Persistencia en localStorage.
   ============================================================ */

const STORE_KEY = 'crtdesk_v1';

/* ============================================================
   REGLAS MULTI-FIRMA
   Cada plan = { firm, plan, size, phases:{eval:{...}, funded:{...}} }
   Campos por fase:
     profitTarget  — objetivo de profit ($). 0 en funded si no aplica.
     drawdown      — cantidad del trailing EOD ($)
     trailLock     — balance de cierre en que el suelo se bloquea (0 = no bloquea)
     lockedFloor   — suelo una vez bloqueado ($) (0 = no aplica)
     dailyLoss     — daily loss limit ($). 0 = sin DLL.
     maxMicro/maxMini — tope de contratos
     minDays       — mínimo días de trading
     consistency   — % máx día/total (0 = sin regla)
     minDailyProfit — mínimo para contar día de payout (funded)
     payoutCap     — tope de retirada
   ============================================================ */

// Preset verificado: LucidFlex (support.lucidtrading.com). Eval y funded comparten trailing.
const FIRM_PRESETS = {
  'LucidFlex': {
    trailing:'eod',
    plans:{
      '25K': { size:25000, eval:{profitTarget:1250,drawdown:1000,trailLock:26100,lockedFloor:25100,dailyLoss:0,maxMicro:20,maxMini:2,minDays:1,consistency:50,minDailyProfit:100,payoutCap:1000},
                          funded:{profitTarget:0,drawdown:1000,trailLock:26100,lockedFloor:25100,dailyLoss:0,maxMicro:20,maxMini:2,minDays:5,consistency:0,minDailyProfit:100,payoutCap:1000} },
      '50K': { size:50000, eval:{profitTarget:3000,drawdown:2000,trailLock:52100,lockedFloor:50100,dailyLoss:0,maxMicro:40,maxMini:4,minDays:1,consistency:50,minDailyProfit:150,payoutCap:2000},
                          funded:{profitTarget:0,drawdown:2000,trailLock:52100,lockedFloor:50100,dailyLoss:0,maxMicro:40,maxMini:4,minDays:5,consistency:0,minDailyProfit:150,payoutCap:2000} },
      '100K':{ size:100000,eval:{profitTarget:6000,drawdown:3000,trailLock:103100,lockedFloor:100100,dailyLoss:0,maxMicro:60,maxMini:6,minDays:1,consistency:50,minDailyProfit:200,payoutCap:2500},
                          funded:{profitTarget:0,drawdown:3000,trailLock:103100,lockedFloor:100100,dailyLoss:0,maxMicro:60,maxMini:6,minDays:5,consistency:0,minDailyProfit:200,payoutCap:2500} },
      '150K':{ size:150000,eval:{profitTarget:9000,drawdown:4500,trailLock:154600,lockedFloor:150100,dailyLoss:0,maxMicro:100,maxMini:10,minDays:1,consistency:50,minDailyProfit:250,payoutCap:3000},
                          funded:{profitTarget:0,drawdown:4500,trailLock:154600,lockedFloor:150100,dailyLoss:0,maxMicro:100,maxMini:10,minDays:5,consistency:0,minDailyProfit:250,payoutCap:3000} }
    }
  },

  // Topstep — 50K (trailing EOD por elección del usuario). Combine + Express Funded (opción Standard).
  'Topstep': {
    trailing:'eod',
    plans:{
      '50K': { size:50000,
        eval:{profitTarget:3000,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:50,maxMini:5,minDays:1,consistency:50,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:50,maxMini:5,minDays:5,consistency:0,minDailyProfit:150,payoutCap:4000} }
    }
  },

  // MyFundedFutures — 50K Builder (Max Drawdown EOD + Daily Drawdown). Micro scaling 10:1.
  'MyFundedFutures': {
    trailing:'eod',
    plans:{
      '50K Builder': { size:50000,
        eval:{profitTarget:3000,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:40,maxMini:4,minDays:1,consistency:0,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:2000,trailLock:0,lockedFloor:0,dailyLoss:1000,maxMicro:40,maxMini:4,minDays:2,consistency:50,minDailyProfit:0,payoutCap:2000} }
    }
  },

  // FundedNext Futures — 50K. Max Loss EOD, sin daily loss.
  'FundedNext': {
    trailing:'eod',
    plans:{
      '50K': { size:50000,
        eval:{profitTarget:2500,drawdown:1500,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:30,maxMini:3,minDays:1,consistency:40,minDailyProfit:0,payoutCap:0},
        funded:{profitTarget:0,drawdown:1500,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:30,maxMini:3,minDays:5,consistency:0,minDailyProfit:0,payoutCap:1500} }
    }
  }
};

const DEFAULTS = {
  trades: [],
  accounts: [],
  firms: null,   // se inicializa desde FIRM_PRESETS la primera vez (así el usuario puede editarlas)
  settings: { riskPerTradePct: 25 },
  meta: { created: Date.now() }
};

let DB = load();

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    const base = raw ? Object.assign(structuredClone(DEFAULTS), JSON.parse(raw)) : structuredClone(DEFAULTS);
    // inicializar firmas desde presets si es la primera vez
    if(!base.firms){ base.firms = structuredClone(FIRM_PRESETS); }
    // añadir firmas de preset que aún no estén (sin pisar las editadas por el usuario)
    Object.keys(FIRM_PRESETS).forEach(f=>{
      if(!base.firms[f]) base.firms[f]=structuredClone(FIRM_PRESETS[f]);
    });
    // migrar cuentas viejas (modelo size/maxDD) al nuevo firm/plan
    (base.accounts||[]).forEach(a=>{
      if(!a.plan && a.size){
        a.firm = a.firm||'LucidFlex';
        a.plan = (a.size/1000)+'K';
        a.phase = a.phase||'Evaluación';
      }
    });
    return base;
  }catch(e){
    const d = structuredClone(DEFAULTS);
    d.firms = structuredClone(FIRM_PRESETS);
    return d;
  }
}

// Helper: obtener specs de un plan/fase
function planSpec(firmName, planName, phase){
  const f = (DB.firms||{})[firmName];
  if(!f || !f.plans[planName]) return null;
  const p = f.plans[planName];
  return { size:p.size, trailing:f.trailing||'eod', ...(p[phase==='Funded'?'funded':'eval']) };
}
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

/* ---------- helpers ---------- */
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const uid = ()=>Math.random().toString(36).slice(2,10);
const fmt = (n,d=2)=> (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('es-ES',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtR = n => (n>0?'+':'')+fmt(n,2)+'R';
const fmt$ = n => (n<0?'-':'')+'$'+fmt(Math.abs(n),0);
const cls = n => n>0?'pos':n<0?'neg':'neu';
const todayISO = ()=> new Date().toISOString().slice(0,10);

function toast(msg){
  const t=$('#toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2200);
}

/* ============================================================
   MÉTRICAS — el corazón del dashboard
   ============================================================ */

// Cada trade:
// {id, date, session, setup, symbol, account,
//  plannedR (R objetivo segun TP/SL al entrar),
//  realizedR (R que sacaste de verdad),
//  pnl ($ real), riskUSD ($ arriesgado),
//  result win|loss|be, flags:[], note}

// Filtro global de fase: 'all' | 'eval' | 'funded'
let PHASE_FILTER = 'all';

// Resuelve la fase de un trade a partir de la cuenta asignada
function tradePhase(t){
  if(!t.account) return null;
  const acc = DB.accounts.find(a=>a.name===t.account);
  if(!acc) return null;
  return acc.phase==='Funded' ? 'funded' : 'eval';
}

function tradesFiltered(filterFn){
  let arr = DB.trades;
  if(PHASE_FILTER!=='all'){
    arr = arr.filter(t=> tradePhase(t)===PHASE_FILTER);
  }
  return arr.filter(filterFn||(()=>true)).sort((a,b)=> a.date<b.date?1:-1);
}

function expectancy(trades){
  if(!trades.length) return 0;
  const sum = trades.reduce((s,t)=> s + (t.realizedR||0), 0);
  return sum / trades.length;
}
function winrate(trades){
  const counted = trades.filter(t=>t.result!=='be');
  if(!counted.length) return 0;
  return counted.filter(t=>t.result==='win').length / counted.length * 100;
}
function avgWin(trades){
  const w = trades.filter(t=>t.result==='win');
  return w.length? w.reduce((s,t)=>s+(t.realizedR||0),0)/w.length : 0;
}
function avgLoss(trades){
  const l = trades.filter(t=>t.result==='loss');
  return l.length? l.reduce((s,t)=>s+(t.realizedR||0),0)/l.length : 0;
}
function profitFactor(trades){
  const gains = trades.filter(t=>t.realizedR>0).reduce((s,t)=>s+t.realizedR,0);
  const losses = Math.abs(trades.filter(t=>t.realizedR<0).reduce((s,t)=>s+t.realizedR,0));
  return losses? gains/losses : (gains>0?Infinity:0);
}
function totalR(trades){ return trades.reduce((s,t)=>s+(t.realizedR||0),0); }
function totalPnl(trades){ return trades.reduce((s,t)=>s+(t.pnl||0),0); }

/* ---------- Comparador de R:R ----------
   Simula el resultado de cada trade bajo un ratio dado.
   - Escenario real (1:1,5): usa realizedR tal cual.
   - Escenario 1:1: usa result11. TP=+1R, SL=-1R, BE=0.
   Solo cuenta trades que tengan result11 registrado. */
function scenarioStats(trades, mode){
  // mode: 'real' | '1:1'
  const valid = mode==='1:1' ? trades.filter(t=>t.result11) : trades;
  if(!valid.length) return {n:0,exp:0,wr:0,totalR:0,pnl:0};
  let sumR=0, wins=0, counted=0, pnl=0;
  valid.forEach(t=>{
    let r;
    if(mode==='1:1'){
      r = t.result11==='win'?1 : t.result11==='loss'?-1 : 0;
    } else {
      r = t.realizedR||0;
    }
    sumR+=r;
    pnl += r*(t.riskUSD||0);
    if(t.result11!=='be' && mode==='1:1'){ counted++; if(r>0)wins++; }
    else if(mode==='real' && t.result!=='be'){ counted++; if(r>0)wins++; }
  });
  return {
    n:valid.length,
    exp:sumR/valid.length,
    wr: counted? wins/counted*100 : 0,
    totalR:sumR,
    pnl
  };
}

// COSTE DE LA INDISCIPLINA — métrica estrella
// Diferencia entre lo planificado y lo realizado en trades marcados con error.
// Si cerraste antes de tiempo un ganador, o entraste por FOMO, etc.
function disciplineCost(trades){
  let lostR = 0, lost$ = 0, flaggedCount = 0, cleanCount = 0;
  trades.forEach(t=>{
    const hasError = (t.flags||[]).some(f=>f!=='clean');
    if(hasError){
      flaggedCount++;
      // R perdido = lo que el plan habria dado menos lo realizado (solo si el plan era mejor)
      const diff = (t.plannedR||0) - (t.realizedR||0);
      if(diff>0){
        lostR += diff;
        lost$ += diff * (t.riskUSD||0);
      }
    } else { cleanCount++; }
  });
  return { lostR, lost$, flaggedCount, cleanCount, total: trades.length };
}

// Tasa de disciplina (% trades sin errores)
function disciplineRate(trades){
  if(!trades.length) return 100;
  const clean = trades.filter(t=> !(t.flags||[]).some(f=>f!=='clean')).length;
  return clean/trades.length*100;
}

// Racha actual de días limpios (sin ningún trade con error)
function cleanDayStreak(trades){
  const byDay = {};
  trades.forEach(t=>{
    byDay[t.date] = byDay[t.date]||[];
    byDay[t.date].push(t);
  });
  const days = Object.keys(byDay).sort().reverse();
  let streak=0;
  for(const d of days){
    const dirty = byDay[d].some(t=>(t.flags||[]).some(f=>f!=='clean'));
    if(dirty) break;
    streak++;
  }
  return streak;
}

// Breakdown por dimensión (setup, session, symbol, weekday)
function breakdown(trades, key){
  const map={};
  trades.forEach(t=>{
    let k = t[key];
    if(key==='weekday') k = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][new Date(t.date).getDay()];
    k = k||'—';
    map[k]=map[k]||[];
    map[k].push(t);
  });
  return Object.entries(map).map(([k,ts])=>({
    key:k, n:ts.length, r:totalR(ts), exp:expectancy(ts), wr:winrate(ts), pnl:totalPnl(ts)
  })).sort((a,b)=>b.r-a.r);
}

// Equity curve (R acumulado en orden cronológico)
function equityCurve(trades){
  const ch = [...trades].sort((a,b)=> a.date<b.date?-1: a.date>b.date?1:0);
  let cum=0; const pts=[];
  ch.forEach(t=>{ cum+=(t.realizedR||0); pts.push({date:t.date, cum}); });
  return pts;
}

// Max drawdown sobre la curva de equity en R
function maxDrawdownR(trades){
  const curve = equityCurve(trades).map(p=>p.cum);
  let peak=0, maxDD=0;
  curve.forEach(v=>{ peak=Math.max(peak,v); maxDD=Math.max(maxDD, peak-v); });
  return maxDD;
}

/* ---------- Kelly / sizing ---------- */
// Kelly fraction usando winrate y ratio ganancia/perdida
function kellyFraction(trades){
  const wr = winrate(trades)/100;
  const aw = avgWin(trades);
  const al = Math.abs(avgLoss(trades));
  if(!al || !aw) return 0;
  const b = aw/al; // payoff ratio
  const k = wr - (1-wr)/b;
  return k; // puede ser negativo si no hay edge
}
/* ============================================================
   VISTAS / RENDER
   ============================================================ */

let CURRENT_TAB = 'overview';
let charts = {};

function destroyCharts(){ Object.values(charts).forEach(c=>{try{c.destroy()}catch(e){}}); charts={}; }

function render(){
  destroyCharts();
  const v = $('#view');
  const T = tradesFiltered();
  // pestañas donde el filtro eval/funded tiene sentido
  const metricTabs=['overview','discipline','performance'];
  const showFilter = metricTabs.includes(CURRENT_TAB);
  if(CURRENT_TAB!=='accounts' && CURRENT_TAB!=='capital' && !T.length){
    v.innerHTML = (showFilter?phaseFilterBar():'') + emptyState();
    return;
  }
  ({
    overview:renderOverview,
    discipline:renderDiscipline,
    performance:renderPerformance,
    capital:renderCapital,
    accounts:renderAccounts,
    calendar:renderCalendar,
    journal:renderJournal
  })[CURRENT_TAB](v, T);
  // prepend filter bar en pestañas de métricas
  if(showFilter){
    v.insertAdjacentHTML('afterbegin', phaseFilterBar());
  }
}

function phaseFilterBar(){
  const opts=[['all','Todo'],['eval','Eval'],['funded','Funded']];
  // contar trades por fase para mostrar
  const counts={all:DB.trades.length, eval:0, funded:0};
  DB.trades.forEach(t=>{ const p=tradePhase(t); if(p)counts[p]++; });
  return `<div class="phase-filter">
    ${opts.map(([k,label])=>`<button class="phase-btn ${PHASE_FILTER===k?'active':''}" onclick="setPhaseFilter('${k}')">${label} <span class="pf-count">${counts[k]}</span></button>`).join('')}
  </div>`;
}
function setPhaseFilter(p){ PHASE_FILTER=p; render(); }

function emptyState(){
  return `<div class="empty">
    <div class="ico">◴</div>
    <p style="font-size:15px;color:var(--ink-dim);margin-bottom:6px">Aún no hay trades registrados</p>
    <p class="hint" style="max-width:340px;margin:0 auto 18px">Empieza añadiendo tu primer trade. Registra el R planificado y el realizado para activar el coste de la indisciplina.</p>
    <button class="btn primary" onclick="openTradeModal()">+ Añadir primer trade</button>
  </div>`;
}

/* ---------- gauge SVG ---------- */
function gauge(pct, label, color){
  const r=64, c=2*Math.PI*r, off=c-(pct/100)*c;
  return `<div class="gauge">
    <svg width="150" height="150" viewBox="0 0 150 150">
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--line)" stroke-width="11"/>
      <circle cx="75" cy="75" r="${r}" fill="none" stroke="${color}" stroke-width="11"
        stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>
    </svg>
    <div class="center"><div><div class="big" style="color:${color}">${Math.round(pct)}<span style="font-size:16px">%</span></div><div class="cap">${label}</div></div></div>
  </div>`;
}

function statCard(label,val,delta,deltaCls){
  return `<div class="card stat">
    <div class="label">${label}</div>
    <div class="val">${val}</div>
    ${delta?`<div class="delta ${deltaCls||''}">${delta}</div>`:''}
  </div>`;
}

/* ============================================================
   OVERVIEW
   ============================================================ */
function renderOverview(v, T){
  const exp = expectancy(T);
  const wr = winrate(T);
  const pf = profitFactor(T);
  const tR = totalR(T);
  const tP = totalPnl(T);
  const dc = disciplineCost(T);
  const dr = disciplineRate(T);
  const ddR = maxDrawdownR(T);

  v.innerHTML = `
    <div class="grid g-4" style="margin-bottom:14px">
      ${statCard('Expectancy', fmtR(exp), exp>=0?'edge positivo':'sin edge', cls(exp))}
      ${statCard('Win rate', fmt(wr,1)+'%', `PF ${pf===Infinity?'∞':fmt(pf,2)}`, 'neu')}
      ${statCard('R acumulado', fmtR(tR), fmt$(tP), cls(tR))}
      ${statCard('Max DD', '-'+fmt(ddR,2)+'R', `${T.length} trades`, 'neu')}
    </div>

    <div class="card disc-card" style="margin-bottom:14px">
      <h3>Coste de la indisciplina <span style="color:var(--ink-faint);text-transform:none;font-weight:400">tu métrica nº1</span></h3>
      <div class="disc-wrap">
        ${gauge(dr, 'disciplina', dr>=80?'var(--green)':dr>=60?'var(--amber)':'var(--red)')}
        <div class="disc-detail">
          <div class="row"><span class="k">R perdido por errores</span><span class="v neg">-${fmt(dc.lostR,2)}R</span></div>
          <div class="row"><span class="k">En dinero</span><span class="v neg">${fmt$(-dc.lost$)}</span></div>
          <div class="row"><span class="k">Trades con error</span><span class="v">${dc.flaggedCount} / ${dc.total}</span></div>
          <div class="row"><span class="k">Racha días limpios</span><span class="v pos">${cleanDayStreak(T)} 🔥</span></div>
        </div>
      </div>
      ${dc.lostR>0?`<div class="insight bad" style="margin-top:16px">Siguiendo tu plan al pie de la letra habrías sumado <b>${fmt(dc.lostR,2)}R más</b> (${fmt$(dc.lost$)}). Eso es ${exp>0?Math.round(dc.lostR/exp):'—'} trades ganadores tirados por errores de ejecución.</div>`:`<div class="insight" style="margin-top:16px">Sin coste de indisciplina detectado en este periodo. Mantén el registro honesto de los flags para que la métrica siga siendo útil.</div>`}
    </div>

    <div class="grid g-2">
      <div class="card">
        <h3>Curva de equity (R)</h3>
        <div style="position:relative;height:220px"><canvas id="equityChart"></canvas></div>
      </div>
      <div class="card">
        <h3>Winrate y expectancy acumulados</h3>
        <div style="position:relative;height:220px"><canvas id="cumChart"></canvas></div>
        <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Winrate %</span><span><span class="dot" style="background:var(--green)"></span>Expectancy (R)</span></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3>Rendimiento por setup</h3>
      ${breakdownTable(breakdown(T,'setup'))}
    </div>

    ${autoInsights(T)}
  `;
  drawEquity('equityChart', T);
  drawCumulative('cumChart', T);
}

function breakdownTable(rows){
  if(!rows.length) return `<p class="hint">Sin datos</p>`;
  return `<div class="table-wrap" style="border:none"><table style="min-width:auto">
    <thead><tr><th>Categoría</th><th>N</th><th>Exp</th><th>WR</th><th>R</th></tr></thead>
    <tbody>${rows.map(r=>`<tr>
      <td style="font-family:var(--sans);font-weight:600">${r.key}</td>
      <td>${r.n}</td>
      <td class="${cls(r.exp)}">${fmtR(r.exp)}</td>
      <td>${fmt(r.wr,0)}%</td>
      <td class="${cls(r.r)}">${fmtR(r.r)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function autoInsights(T){
  const ins=[];
  // mejor y peor setup
  const bs = breakdown(T,'setup');
  if(bs.length>=2){
    const best=bs[0], worst=bs[bs.length-1];
    if(best.exp>0) ins.push({t:`Tu mejor setup es <b>${best.key}</b> con ${fmtR(best.exp)} de expectancy sobre ${best.n} trades.`,c:''});
    if(worst.exp<0) ins.push({t:`<b>${worst.key}</b> tiene expectancy negativa (${fmtR(worst.exp)}). Plantéate filtrar o suspender este setup.`,c:'bad'});
  }
  // sesión
  const sb = breakdown(T,'session');
  if(sb.length>=2){
    const bestS=sb[0];
    ins.push({t:`Operas mejor en sesión <b>${bestS.key}</b> (${fmtR(bestS.exp)} exp). Concentra ahí tu tamaño.`,c:''});
  }
  // flags más comunes
  const flagCount={};
  T.forEach(t=>(t.flags||[]).forEach(f=>{if(f!=='clean'){flagCount[f]=(flagCount[f]||0)+1}}));
  const topFlag = Object.entries(flagCount).sort((a,b)=>b[1]-a[1])[0];
  if(topFlag) ins.push({t:`Tu error más repetido: <b>${FLAG_LABELS[topFlag[0]]||topFlag[0]}</b> (${topFlag[1]} veces). Ponlo en tu checklist pre-sesión.`,c:'warn'});

  if(!ins.length) return '';
  return `<div style="margin-top:14px">${ins.map(i=>`<div class="insight ${i.c}">${i.t}</div>`).join('')}</div>`;
}

/* ============================================================
   DISCIPLINE
   ============================================================ */
function renderDiscipline(v, T){
  const dc = disciplineCost(T);
  const dr = disciplineRate(T);
  // por flag
  const flagStats={};
  Object.keys(FLAG_LABELS).forEach(f=>{ if(f!=='clean') flagStats[f]={n:0,lostR:0}; });
  T.forEach(t=>{
    (t.flags||[]).forEach(f=>{
      if(f!=='clean' && flagStats[f]){
        flagStats[f].n++;
        const diff=(t.plannedR||0)-(t.realizedR||0);
        if(diff>0) flagStats[f].lostR+=diff;
      }
    });
  });
  const flagRows=Object.entries(flagStats).filter(([k,s])=>s.n>0).sort((a,b)=>b[1].lostR-a[1].lostR);

  // disciplina vs resultado: ¿los trades limpios rinden mejor?
  const clean=T.filter(t=>!(t.flags||[]).some(f=>f!=='clean'));
  const dirty=T.filter(t=>(t.flags||[]).some(f=>f!=='clean'));

  v.innerHTML=`
    <div class="section-title">Disciplina & errores</div>
    <div class="grid g-3" style="margin-bottom:14px">
      ${statCard('Tasa de disciplina', fmt(dr,1)+'%', `${dc.cleanCount} trades limpios`, dr>=80?'pos':'neg')}
      ${statCard('Coste total errores', '-'+fmt(dc.lostR,2)+'R', fmt$(-dc.lost$), 'neg')}
      ${statCard('Racha días limpios', cleanDayStreak(T)+' días', 'sin errores', 'pos')}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>¿Tu edge sobrevive a los errores?</h3>
      <div class="grid g-2">
        <div class="calc-out">
          <div class="label" style="color:var(--green);font-size:11px;font-weight:600;margin-bottom:6px">TRADES LIMPIOS (${clean.length})</div>
          <div class="big pos">${fmtR(expectancy(clean))}</div>
          <div class="hint" style="margin-top:6px">WR ${fmt(winrate(clean),0)}% · PF ${fmt(profitFactor(clean),2)}</div>
        </div>
        <div class="calc-out">
          <div class="label" style="color:var(--red);font-size:11px;font-weight:600;margin-bottom:6px">TRADES CON ERROR (${dirty.length})</div>
          <div class="big neg">${fmtR(expectancy(dirty))}</div>
          <div class="hint" style="margin-top:6px">WR ${fmt(winrate(dirty),0)}% · PF ${fmt(profitFactor(dirty),2)}</div>
        </div>
      </div>
      ${clean.length&&dirty.length?`<div class="insight warn" style="margin-top:14px">La diferencia de expectancy entre operar limpio y operar con errores es de <b>${fmtR(expectancy(clean)-expectancy(dirty))}</b> por trade. Multiplícalo por tu volumen mensual para ver el coste real anual.</div>`:''}
    </div>

    <div class="card">
      <h3>Desglose por tipo de error</h3>
      ${flagRows.length?`<div class="table-wrap" style="border:none"><table style="min-width:auto">
        <thead><tr><th>Error</th><th>Veces</th><th>R perdido</th><th>% de tus trades</th></tr></thead>
        <tbody>${flagRows.map(([k,s])=>`<tr>
          <td style="font-family:var(--sans);font-weight:600">${FLAG_LABELS[k]}</td>
          <td>${s.n}</td>
          <td class="neg">-${fmt(s.lostR,2)}R</td>
          <td>${fmt(s.n/T.length*100,0)}%</td>
        </tr>`).join('')}</tbody></table></div>`:`<p class="hint">Ningún error registrado. 🎯</p>`}
    </div>

    ${(()=>{
      const withPlan=T.filter(t=>t.planChecked!=null);
      if(withPlan.length<3) return '';
      const full=withPlan.filter(t=>(t.planChecked||[]).length===PLAN_CHECKLIST.length);
      const partial=withPlan.filter(t=>(t.planChecked||[]).length<PLAN_CHECKLIST.length);
      if(!full.length||!partial.length) return '';
      const diff=expectancy(full)-expectancy(partial);
      return `<div class="card" style="margin-top:14px">
        <h3>Adherencia al plan</h3>
        <div class="grid g-2">
          <div class="calc-out">
            <div class="label" style="color:var(--green);font-size:11px;font-weight:600;margin-bottom:6px">PLAN COMPLETO (${full.length})</div>
            <div class="big pos">${fmtR(expectancy(full))}</div>
            <div class="hint" style="margin-top:6px">WR ${fmt(winrate(full),0)}%</div>
          </div>
          <div class="calc-out">
            <div class="label" style="color:var(--amber);font-size:11px;font-weight:600;margin-bottom:6px">PLAN INCOMPLETO (${partial.length})</div>
            <div class="big ${cls(expectancy(partial))}">${fmtR(expectancy(partial))}</div>
            <div class="hint" style="margin-top:6px">WR ${fmt(winrate(partial),0)}%</div>
          </div>
        </div>
        ${diff>0?`<div class="insight warn" style="margin-top:14px">Cuando cumples todas las reglas de tu plan ganas <b>${fmtR(diff)} más</b> por trade que cuando te saltas alguna. Tu plan funciona — respétalo.</div>`:`<div class="insight" style="margin-top:14px">Aún no hay diferencia clara entre cumplir todo el plan o no. Sigue registrando para que el dato sea fiable.</div>`}
      </div>`;
    })()}
  `;
}

/* ============================================================
   PERFORMANCE
   ============================================================ */
function renderPerformance(v, T){
  v.innerHTML=`
    <div class="section-title">Rendimiento</div>
    <div class="grid g-4" style="margin-bottom:14px">
      ${statCard('Expectancy', fmtR(expectancy(T)),'por trade',cls(expectancy(T)))}
      ${statCard('Avg win', fmtR(avgWin(T)),'',('pos'))}
      ${statCard('Avg loss', fmtR(avgLoss(T)),'',('neg'))}
      ${statCard('Profit factor', profitFactor(T)===Infinity?'∞':fmt(profitFactor(T),2),'',cls(profitFactor(T)-1))}
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="card"><h3>Por sesión</h3>${breakdownTable(breakdown(T,'session'))}</div>
      <div class="card"><h3>Por símbolo</h3>${breakdownTable(breakdown(T,'symbol'))}</div>
    </div>
    <div class="grid g-2" style="margin-bottom:14px">
      <div class="card"><h3>Por día de la semana</h3>${breakdownTable(breakdown(T,'weekday'))}</div>
      <div class="card"><h3>Por setup</h3>${breakdownTable(breakdown(T,'setup'))}</div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3>Comparador de R:R — tu 1:1,5 vs 1:1</h3>
      ${(()=>{
        const real=scenarioStats(T,'real');
        const withData=T.filter(t=>t.result11);
        if(withData.length<3) return `<p class="hint">Necesitas al menos 3 trades con el resultado a 1:1 registrado para comparar. Llevas ${withData.length}. Ve marcando "¿Qué habría pasado a 1:1?" al registrar cada trade.</p>`;
        // comparar SOLO sobre los trades que tienen ambos datos, para ser justos
        const realSub=scenarioStats(withData,'real');
        const alt=scenarioStats(withData,'1:1');
        const better = realSub.pnl>=alt.pnl ? 'real' : '1:1';
        const diff=Math.abs(realSub.pnl-alt.pnl);
        return `
        <div class="grid g-2">
          <div class="calc-out" style="${better==='real'?'border-color:var(--green-dim)':''}">
            <div class="label" style="font-size:11px;font-weight:600;margin-bottom:6px;color:${better==='real'?'var(--green)':'var(--ink-dim)'}">TU 1:1,5 ${better==='real'?'👑':''}</div>
            <div class="big ${cls(realSub.pnl)}">${fmt$(realSub.pnl)}</div>
            <div class="hint" style="margin-top:8px">Exp ${fmtR(realSub.exp)} · WR ${fmt(realSub.wr,0)}% · ${fmtR(realSub.totalR)}</div>
          </div>
          <div class="calc-out" style="${better==='1:1'?'border-color:var(--green-dim)':''}">
            <div class="label" style="font-size:11px;font-weight:600;margin-bottom:6px;color:${better==='1:1'?'var(--green)':'var(--ink-dim)'}">A 1:1 ${better==='1:1'?'👑':''}</div>
            <div class="big ${cls(alt.pnl)}">${fmt$(alt.pnl)}</div>
            <div class="hint" style="margin-top:8px">Exp ${fmtR(alt.exp)} · WR ${fmt(alt.wr,0)}% · ${fmtR(alt.totalR)}</div>
          </div>
        </div>
        <div class="insight ${better==='real'?'':'warn'}" style="margin-top:14px">
          Sobre ${withData.length} trades comparables, ${better==='real'
            ? `tu <b>1:1,5 rinde mejor</b>: ${fmt$(diff)} más que ir a 1:1. Tu ratio actual es el correcto.`
            : `ir a <b>1:1 habría rendido ${fmt$(diff)} más</b>. El winrate más alto compensa el objetivo más corto. Plantéate probar 1:1 en una parte de tu size.`}
        </div>
        <div class="hint" style="margin-top:8px">Comparación justa: solo cuenta los ${withData.length} trades donde registraste ambos resultados.</div>
        `;
      })()}
    </div>
    <div class="card">
      <h3>Distribución de R por trade</h3>
      <div style="position:relative;height:200px"><canvas id="distChart"></canvas></div>
    </div>
  `;
  drawDistribution('distChart', T);
}

/* ============================================================
   CAPITAL & SIZING
   ============================================================ */
function planOptionsHTML(selId){
  // genera <option> "Firma|Plan|Fase" para todos los planes de todas las firmas
  let opts='';
  Object.keys(DB.firms||{}).forEach(firm=>{
    Object.keys(DB.firms[firm].plans).forEach(plan=>{
      ['Evaluación','Funded'].forEach(phase=>{
        const val=`${firm}|${plan}|${phase}`;
        opts+=`<option value="${val}">${firm} ${plan} · ${phase}</option>`;
      });
    });
  });
  return opts;
}
function selectedSpec(selId){
  const val=$('#'+selId)?.value||'';
  const [firm,plan,phase]=val.split('|');
  return planSpec(firm,plan,phase);
}

function renderCapital(v, T){
  const k = kellyFraction(T);
  const halfK = k/2, quarterK = k/4;

  v.innerHTML=`
    <div class="section-title">Sizing</div>

    <div class="insight" style="margin-bottom:16px">
      Todas tus firmas usan <b>trailing EOD</b>: el suelo sube con tu balance de cierre. El sizing se calcula sobre tu <b>margen actual hasta el drawdown</b>. Si tu plan tiene daily loss limit, respétalo también — la calculadora te avisa.
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Calculadora de sizing por margen al drawdown</h3>
      <div class="field-row">
        <div class="field"><label>Cuenta</label><select id="szAcct" onchange="calcSize()">${planOptionsHTML('szAcct')}</select></div>
        <div class="field"><label>Balance de cierre actual ($)</label><input type="number" id="szBal" value="50000" oninput="calcSize()"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Riesgo ($) o % del margen</label><input type="number" id="szRiskUSD" value="" placeholder="ex. 660" oninput="calcSize()"></div>
        <div class="field"><label>Stop (puntos)</label><input type="number" id="szPoints" value="60" oninput="calcSize()"></div>
        <div class="field"><label>Valor por punto ($)</label><input type="number" id="szPtVal" value="2" step="0.01" oninput="calcSize()"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Riesgo máx/trade (% del margen, si dejas $ vacío)</label><input type="number" id="szPct" value="25" oninput="calcSize()"></div>
        <div class="field"><label>Máx. stops/sesión</label><input type="number" id="szMaxStops" value="2" oninput="calcSize()"></div>
      </div>
      <div class="hint" style="margin:-4px 0 12px">Valor por punto: MNQ $2 · MES $5 · MYM $0.50 · M2K $5 · M6E $12.50 · NQ $20 · ES $50 · YM $5. (1 punt MNQ = 4 ticks × $0.50 = $2)</div>
      <div class="calc-out" id="szOut"></div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Validación de edge (Kelly)</h3>
      <div class="grid g-3">
        ${statCard('Kelly completo', T.length>=30?fmt(k*100,1)+'%':'n/a', T.length>=30?'no usar directo':'necesitas 30+ trades','neu')}
        ${statCard('½ Kelly', T.length>=30?fmt(halfK*100,1)+'%':'n/a','~75% crecimiento','pos')}
        ${statCard('¼ Kelly', T.length>=30?fmt(quarterK*100,1)+'%':'n/a','mínima varianza','neu')}
      </div>
      <div class="insight" style="margin-top:14px">Kelly aquí es solo un termómetro de tu edge, no tu sizing. ${k>0?`Tu edge es positivo (Kelly ${fmt(k*100,1)}%), lo que valida arriesgar fijo por trade.`:`Kelly ≤ 0 o sin datos: aún no hay edge demostrado para subir tamaño.`}</div>
    </div>

    <div class="card">
      <h3>Proyección de payout</h3>
      <div class="field-row-3">
        <div class="field"><label>Cuenta</label><select id="pjAcct" onchange="calcPayout()">${planOptionsHTML('pjAcct')}</select></div>
        <div class="field"><label>Profit medio/día ganador ($)</label><input type="number" id="pjDaily" value="300" oninput="calcPayout()"></div>
        <div class="field"><label>Días ganadores/semana</label><input type="number" id="pjDays" value="3" oninput="calcPayout()"></div>
      </div>
      <div class="calc-out" id="pjOut"></div>
    </div>
  `;
  // seleccionar por defecto la primera fase funded si existe
  calcSize(); calcPayout();
}

function calcSize(){
  const spec=selectedSpec('szAcct');
  if(!spec){ $('#szOut').innerHTML='<p class="hint">Selecciona una cuenta.</p>'; return; }
  const bal=+$('#szBal').value||0, pct=+$('#szPct').value||0,
        points=+$('#szPoints').value||0, ptVal=+$('#szPtVal').value||0,
        maxStops=+$('#szMaxStops').value||1;
  const riskUSDinput=parseFloat($('#szRiskUSD').value);
  const trailLock=spec.trailLock||0, lockedFloor=spec.lockedFloor||0, dd=spec.drawdown||0;
  let floor;
  if(trailLock && bal>=trailLock) floor=lockedFloor;
  else floor=bal-dd;
  const room = bal - floor;
  // risc per trade: si l'usuari posa $ directe, s'usa; si no, % del marge
  const usingDirect = !isNaN(riskUSDinput) && riskUSDinput>0;
  const riskPerTrade = usingDirect ? riskUSDinput : room*(pct/100);
  const riskPerContract = points*ptVal;   // punts × valor per punt
  const contractsRaw = riskPerContract? Math.floor(riskPerTrade/riskPerContract):0;
  const maxC = spec.maxMicro||9999;
  const contracts = Math.max(0, Math.min(contractsRaw, maxC));
  const cappedByPlan = contractsRaw>maxC;
  const actualRisk = contracts*riskPerContract;
  const ifMaxStops = actualRisk*maxStops;
  const dll = spec.dailyLoss||0;
  const safeRoom = ifMaxStops <= room;
  const safeDLL = !dll || ifMaxStops <= dll;
  $('#szOut').innerHTML=`
    <div class="grid g-4" style="gap:10px">
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">MARGEN AL DD</div><div class="big">${fmt$(room)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">RIESGO/TRADE</div><div class="big">${fmt$(riskPerTrade)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">CONTRATOS (micros)</div><div class="big" style="color:var(--green)">${contracts}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">RIESGO REAL</div><div class="big">${fmt$(actualRisk)}</div></div>
    </div>
    <hr class="sep">
    <div class="hint">Risc per contracte: ${points} punts × ${fmt$(ptVal)}/punt = <b>${fmt$(riskPerContract)}</b> · ${usingDirect?`Fent servir risc directe de ${fmt$(riskPerTrade)}`:`Fent servir ${pct}% del marge`}</div>
    <div class="hint" style="margin-top:6px">Suelo DD actual: <b>${fmt$(floor)}</b>${trailLock&&bal>=trailLock?' (bloqueado ✓)':' (aún trailing)'} · Tope del plan: ${maxC===9999?'—':maxC+' micros'}${spec.maxMini?' / '+spec.maxMini+' minis':''}</div>
    ${cappedByPlan?`<div class="hint dd-warn" style="margin-top:6px">El càlcul demanava ${contractsRaw} contractes, però el pla limita a ${maxC}. Retallat al màxim.</div>`:''}
    <div class="hint ${safeRoom?'':'dd-warn'}" style="margin-top:6px">Con ${maxStops} stops seguidos perderías <b>${fmt$(ifMaxStops)}</b> ${safeRoom?`— dentro de tu margen de ${fmt$(room)}. ✓`:`— ¡te acerca al drawdown! Reduce riesgo o stop.`}</div>
    ${dll?`<div class="hint ${safeDLL?'':'dd-warn'}" style="margin-top:6px">Daily loss limit ${fmt$(dll)}: ${safeDLL?`${maxStops} stops (${fmt$(ifMaxStops)}) caben dentro. ✓`:`⚠ ${maxStops} stops (${fmt$(ifMaxStops)}) superan el DLL. Baja el riesgo.`}</div>`:''}
  `;
}

function calcPayout(){
  const spec=selectedSpec('pjAcct');
  if(!spec){ $('#pjOut').innerHTML='<p class="hint">Selecciona una cuenta.</p>'; return; }
  const daily=+$('#pjDaily').value||0, daysWk=+$('#pjDays').value||0;
  const minDP=spec.minDailyProfit||0;
  const daysReq=spec.minDays||5;
  const meetsMin = minDP? daily>=minDP : daily>0;
  const weeksToPayout = meetsMin && daysWk>0 ? Math.ceil(daysReq/daysWk) : Infinity;
  const cycleProfit = daily*daysWk*(weeksToPayout===Infinity?0:weeksToPayout);
  const cap = spec.payoutCap||Infinity;
  const grossPayout = Math.min(cycleProfit, cap);
  $('#pjOut').innerHTML=`
    <div class="grid g-3" style="gap:10px">
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">SEMANAS AL 1er PAYOUT</div><div class="big">${weeksToPayout===Infinity?'—':weeksToPayout}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">PROFIT ACUMULADO</div><div class="big">${fmt$(cycleProfit)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">PAYOUT (máx${cap!==Infinity?' cap':''})</div><div class="big" style="color:var(--green)">${fmt$(grossPayout)}</div></div>
    </div>
    <hr class="sep">
    <div class="hint ${meetsMin?'':'dd-warn'}">${meetsMin
      ? `Necesitas ${daysReq} días con profit${minDP?` ≥ ${fmt$(minDP)}`:''} y neto positivo para pedir payout.${cap!==Infinity?` Tope de retirada: ${fmt$(cap)}.`:''}`
      : `⚠ ${fmt$(daily)}/día no llega al mínimo de ${fmt$(minDP)} que exige el plan para contar como día de payout.`}</div>
  `;
}
/* ============================================================
   ACCOUNTS & PAYOUTS
   ============================================================ */
function renderAccounts(v, T){
  const accts = DB.accounts;
  v.innerHTML=`
    <div class="section-title" style="display:flex;justify-content:space-between;align-items:center">
      <span>Cuentas & Payouts</span>
      <div style="display:flex;gap:8px">
        <button class="btn ghost sm" onclick="openFirmEditor()">⚙ Editar reglas</button>
        <button class="btn primary sm" onclick="openAccountModal()">+ Cuenta</button>
      </div>
    </div>
    ${!accts.length?`<div class="empty"><div class="ico">▤</div><p class="hint">Sin cuentas. Añade una de tus firmas (LucidFlex, Topstep, MyFundedFutures, FundedNext...) y las reglas se cargan solas.</p><button class="btn primary" style="margin-top:14px" onclick="openAccountModal()">+ Añadir cuenta</button></div>`:
    accts.map(a=>{
      const spec = planSpec(a.firm, a.plan, a.phase) || {};
      const aTrades = T.filter(t=>t.account===a.name);
      const realized = totalPnl(aTrades);
      const balance = (a.startBalance||0)+realized;
      const dd = spec.drawdown||0;
      const trailLock = spec.trailLock||0;
      const lockedFloor = spec.lockedFloor||0;
      // Trailing EOD genérico: suelo sube con balance hasta trailLock, luego bloqueado en lockedFloor
      let floor;
      if(trailLock && balance>=trailLock) floor = lockedFloor;
      else floor = balance - dd;
      const locked = trailLock && balance>=trailLock;
      const ddRoom = balance - floor;
      const ddPct = dd? Math.max(0,Math.min(100, ddRoom/dd*100)) : 0;

      const target = spec.profitTarget||0;
      const targetRoom = a.phase==='Evaluación'&&target? (a.startBalance+target) - balance : 0;
      const targetPct = a.phase==='Evaluación'&&target? Math.max(0,Math.min(100, realized/target*100)) : 0;

      // payout tracking (funded): días con profit >= minDailyProfit
      const profitByDay={};
      aTrades.forEach(t=>{ profitByDay[t.date]=(profitByDay[t.date]||0)+(t.pnl||0); });
      const minDP=spec.minDailyProfit||0;
      const qualDays = Object.values(profitByDay).filter(p=>minDP?p>=minDP:p>0).length;
      const daysReq = spec.minDays||5;
      const payoutReady = qualDays>=daysReq && realized>0;

      // consistency (si aplica): mayor día / profit total
      const dayProfits=Object.values(profitByDay).filter(p=>p>0);
      const maxDay=dayProfits.length?Math.max(...dayProfits):0;
      const consistency = realized>0? maxDay/realized*100 : 0;
      const consLimit = spec.consistency||0;
      const consistencyOK = !consLimit || consistency<=consLimit;

      // daily loss limit: peor día
      const worstDay = Math.min(0, ...Object.values(profitByDay));
      const dll = spec.dailyLoss||0;

      const firmObj=DB.firms[a.firm]||{};
      const trailLabel = (firmObj.trailing||'eod')==='eod'?'EOD trailing':(firmObj.trailing==='intraday'?'trailing intradía':'estático');

      return `<div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div>
            <div style="font-size:15px;font-weight:700">${a.name}</div>
            <div class="acct-meta">${a.firm} ${a.plan} · ${a.phase} · ${trailLabel} · ${aTrades.length} trades</div>
          </div>
          <div style="display:flex;gap:6px">
            <span class="tag ${ddPct>40?'ok':ddPct>20?'warn':'bad'}">DD ${fmt(ddPct,0)}%</span>
            <button class="btn ghost sm icon" onclick="editAccount('${a.id}')" title="Editar">✎</button>
          </div>
        </div>
        <div class="grid g-3" style="gap:10px;margin-bottom:14px">
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">BALANCE</div><div style="font-family:var(--mono);font-size:18px;font-weight:700">${fmt$(balance)}</div></div>
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">P&L</div><div style="font-family:var(--mono);font-size:18px;font-weight:700" class="${cls(realized)}">${fmt$(realized)}</div></div>
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">SUELO DD ${locked?'🔒':''}</div><div style="font-family:var(--mono);font-size:18px;font-weight:700">${fmt$(floor)}</div></div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Margen hasta drawdown (breach)</span><span style="font-family:var(--mono)">${fmt$(ddRoom)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${ddPct}%;background:${ddPct>40?'var(--green)':ddPct>20?'var(--amber)':'var(--red)'}"></div></div>
        </div>
        ${dll?`<div class="insight ${worstDay>-dll?'':'bad'}" style="margin:0 0 12px">Daily loss limit: <b>${fmt$(dll)}</b>. Tu peor día: ${fmt$(worstDay)}. ${worstDay>-dll?'Dentro del límite ✓':'⚠ ¡Superaste el DLL!'}</div>`:''}
        ${a.phase==='Evaluación'&&target?`
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Progreso al profit target</span><span style="font-family:var(--mono)">${fmt(targetPct,0)}% · faltan ${fmt$(Math.max(0,targetRoom))}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${targetPct}%;background:var(--blue)"></div></div>
        </div>`:''}
        ${consLimit?`<div class="insight ${consistencyOK?'':'warn'}" style="margin-top:10px">Consistency: tu mayor día es <b>${fmt(consistency,0)}%</b> del profit (límite ${consLimit}%). ${consistencyOK?'Dentro ✓':'⚠ Reparte más el profit entre días.'}</div>`:''}
        ${a.phase==='Funded'?`
        <div style="margin-bottom:6px;margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Días con profit para payout${minDP?` (≥${fmt$(minDP)})`:''}</span><span style="font-family:var(--mono)">${qualDays} / ${daysReq}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,qualDays/daysReq*100)}%;background:${payoutReady?'var(--green)':'var(--violet)'}"></div></div>
        </div>
        <div class="insight" style="margin-top:10px">${payoutReady
          ? `✓ <b>Payout disponible.</b> ${qualDays} días con profit y neto positivo.${spec.payoutCap?` Tope de retirada ${fmt$(spec.payoutCap)}.`:''}`
          : `Te faltan <b>${Math.max(0,daysReq-qualDays)} días</b> con profit${minDP?` ≥ ${fmt$(minDP)}`:''} para pedir payout.`}</div>
        `:''}
      </div>`;
    }).join('')}
    ${accts.length?`<div class="insight" style="margin-top:6px">Todas tus firmas usan <b>trailing EOD</b>: el suelo sube con tu balance de cierre y, si el plan tiene trail lock, se bloquea al superarlo (🔒). Las que tienen daily loss limit se marcan aparte. Revisa las reglas exactas de cada firma con ⚙ Editar reglas.</div>`:''}
  `;
}

/* ============================================================
   CALENDAR
   ============================================================ */
let CAL_MONTH = new Date().getMonth();
let CAL_YEAR = new Date().getFullYear();

function calShift(delta){
  CAL_MONTH += delta;
  if(CAL_MONTH<0){ CAL_MONTH=11; CAL_YEAR--; }
  if(CAL_MONTH>11){ CAL_MONTH=0; CAL_YEAR++; }
  render();
}

function renderCalendar(v, T){
  const monthName = new Date(CAL_YEAR,CAL_MONTH,1).toLocaleDateString('es-ES',{month:'long',year:'numeric'});
  const first = new Date(CAL_YEAR,CAL_MONTH,1);
  const startDow = (first.getDay()+6)%7; // lunes=0
  const daysInMonth = new Date(CAL_YEAR,CAL_MONTH+1,0).getDate();
  const todayStr = todayISO();

  // agrupar trades por día del mes visible (parseo local explícito, sin desfase TZ)
  const byDay={};
  T.forEach(t=>{
    const [yy,mm,dd]=t.date.split('-').map(Number);
    if(yy===CAL_YEAR && (mm-1)===CAL_MONTH){
      const day=dd;
      byDay[day]=byDay[day]||{pnl:0,n:0,dirty:false,r:0};
      byDay[day].pnl+=(t.pnl||0);
      byDay[day].r+=(t.realizedR||0);
      byDay[day].n++;
      if((t.flags||[]).some(f=>f!=='clean')) byDay[day].dirty=true;
    }
  });

  // stats del mes
  const monthDays=Object.values(byDay);
  const monthPnl=monthDays.reduce((s,d)=>s+d.pnl,0);
  const greenDays=monthDays.filter(d=>d.pnl>0).length;
  const redDays=monthDays.filter(d=>d.pnl<0).length;

  const dows=['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
  let cells='';
  for(let i=0;i<startDow;i++) cells+=`<div class="cal-cell empty"></div>`;
  for(let day=1;day<=daysInMonth;day++){
    const d=byDay[day];
    const dateStr=`${CAL_YEAR}-${String(CAL_MONTH+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday=dateStr===todayStr;
    if(d){
      const klass=d.pnl>0?'win':d.pnl<0?'loss':'';
      cells+=`<div class="cal-cell clickable ${klass} ${isToday?'today':''}" onclick="calDayDetail('${dateStr}')">
        <div class="daynum">${day}</div>
        ${d.dirty?'<div class="flag-dot" title="día con error"></div>':''}
        <div class="pnl ${cls(d.pnl)}">${fmt$(d.pnl)}</div>
        <div class="meta">${d.n} trade${d.n>1?'s':''} · ${fmtR(d.r)}</div>
      </div>`;
    } else {
      cells+=`<div class="cal-cell ${isToday?'today':''}"><div class="daynum">${day}</div></div>`;
    }
  }

  v.innerHTML=`
    <div class="cal-head">
      <button class="btn ghost sm icon" onclick="calShift(-1)">←</button>
      <div class="month">${monthName}</div>
      <button class="btn ghost sm icon" onclick="calShift(1)">→</button>
    </div>
    <div class="cal-grid">
      ${dows.map(d=>`<div class="cal-dow">${d}</div>`).join('')}
      ${cells}
    </div>
    <div class="cal-month-stats">
      <div class="s"><span class="k">P&L del mes</span><span class="v ${cls(monthPnl)}">${fmt$(monthPnl)}</span></div>
      <div class="s"><span class="k">Días verdes</span><span class="v pos">${greenDays}</span></div>
      <div class="s"><span class="k">Días rojos</span><span class="v neg">${redDays}</span></div>
      <div class="s"><span class="k">Días operados</span><span class="v">${monthDays.length}</span></div>
    </div>
    <div class="hint" style="margin-top:14px">Toca un día para ver el detalle de sus trades. El punto rojo marca días con algún error de ejecución.</div>
  `;
}

function calDayDetail(dateStr){
  const dayTrades=DB.trades.filter(t=>t.date===dateStr).sort((a,b)=>a.id<b.id?-1:1);
  const dPnl=totalPnl(dayTrades), dR=totalR(dayTrades);
  const human=new Date(dateStr).toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'});
  $('#modalBg').innerHTML=`<div class="modal">
    <h2 style="text-transform:capitalize">${human} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="grid g-3" style="gap:10px;margin-bottom:16px">
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">P&L</div><div class="big ${cls(dPnl)}">${fmt$(dPnl)}</div></div>
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">R TOTAL</div><div class="big ${cls(dR)}">${fmtR(dR)}</div></div>
      <div class="calc-out"><div class="label" style="font-size:10px;color:var(--ink-faint)">TRADES</div><div class="big">${dayTrades.length}</div></div>
    </div>
    ${dayTrades.map(t=>{
      const errs=(t.flags||[]).filter(f=>f!=='clean');
      return `<div class="card" style="padding:12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><b>${t.symbol}</b> <span class="hint">${t.setup} · ${t.session}</span></div>
          <div style="font-family:var(--mono);font-weight:700" class="${cls(t.realizedR)}">${fmtR(t.realizedR)} · ${fmt$(t.pnl)}</div>
        </div>
        ${errs.length?`<div style="margin-top:6px">${errs.map(f=>`<span class="tag bad" style="margin:1px">${FLAG_LABELS[f]||f}</span>`).join('')}</div>`:''}
        ${t.note?`<div class="hint" style="margin-top:6px">${t.note}</div>`:''}
        ${(t.images&&t.images.length)?`<div class="thumb-row">${t.images.map(img=>`<img class="thumb" src="${img}" onclick="lightbox('${img}')">`).join('')}</div>`:''}
      </div>`;
    }).join('')||'<p class="hint">Sin trades este día.</p>'}
    <div class="modal-actions"><button class="btn ghost" onclick="closeModal()">Cerrar</button></div>
  </div>`;
  $('#modalBg').classList.add('show');
}

function lightbox(src){
  let lb=$('#lightbox');
  if(!lb){ lb=document.createElement('div'); lb.id='lightbox'; lb.className='lightbox'; lb.onclick=()=>lb.classList.remove('show'); document.body.appendChild(lb); }
  lb.innerHTML=`<img src="${src}">`;
  lb.classList.add('show');
}

/* ============================================================
   JOURNAL
   ============================================================ */
let JOURNAL_FILTER = 'all';
function renderJournal(v, T){
  const filtered = JOURNAL_FILTER==='errors' ? T.filter(t=>(t.flags||[]).some(f=>f!=='clean')) :
                   JOURNAL_FILTER==='clean' ? T.filter(t=>!(t.flags||[]).some(f=>f!=='clean')) : T;
  v.innerHTML=`
    <div class="section-title">Journal</div>
    <div class="pill-row">
      <button class="chip ${JOURNAL_FILTER==='all'?'on good':''}" onclick="setJournalFilter('all')">Todos (${T.length})</button>
      <button class="chip ${JOURNAL_FILTER==='clean'?'on good':''}" onclick="setJournalFilter('clean')">Limpios</button>
      <button class="chip ${JOURNAL_FILTER==='errors'?'on':''}" onclick="setJournalFilter('errors')">Con error</button>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Fecha</th><th>Símbolo</th><th>Setup</th><th>Sesión</th><th>Plan R</th><th>Real R</th><th>P&L</th><th>Estado</th><th>Flags</th><th></th></tr></thead>
      <tbody>${filtered.map(t=>{
        const errs=(t.flags||[]).filter(f=>f!=='clean');
        return `<tr>
          <td>${t.date}</td>
          <td>${t.symbol||'—'}${(t.images&&t.images.length)?` <span title="${t.images.length} imagen(es)" style="opacity:.6">📎</span>`:''}</td>
          <td style="font-family:var(--sans)">${t.setup||'—'}</td>
          <td>${t.session||'—'}</td>
          <td>${fmt(t.plannedR,1)}</td>
          <td class="${cls(t.realizedR)}">${fmtR(t.realizedR)}</td>
          <td class="${cls(t.pnl)}">${fmt$(t.pnl)}</td>
          <td><span class="tag ${t.result==='win'?'ok':t.result==='loss'?'bad':'neutral'}">${t.result}</span></td>
          <td>${errs.length?errs.map(f=>`<span class="tag bad" style="margin:1px">${FLAG_LABELS[f]||f}</span>`).join(''):'<span class="tag ok">limpio</span>'}</td>
          <td><button class="btn ghost sm icon" onclick="editTrade('${t.id}')">✎</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  `;
}
function setJournalFilter(f){ JOURNAL_FILTER=f; render(); }

/* ============================================================
   CHARTS
   ============================================================ */
function chartBase(){
  return {responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{backgroundColor:'#161c27',borderColor:'#1f2733',borderWidth:1,titleColor:'#e8edf4',bodyColor:'#8a97a8',padding:10}},
    scales:{x:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}},y:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}}}};
}
function drawEquity(id, T){
  const el=$('#'+id); if(!el) return;
  const curve=equityCurve(T);
  const final=curve.length?curve[curve.length-1].cum:0;
  const color=final>=0?'#3ddc84':'#ff5d5d';
  const grad=el.getContext('2d').createLinearGradient(0,0,0,200);
  grad.addColorStop(0, final>=0?'rgba(61,220,132,.25)':'rgba(255,93,93,.25)');
  grad.addColorStop(1,'rgba(0,0,0,0)');
  charts.eq=new Chart(el,{type:'line',data:{labels:curve.map((p,i)=>i+1),
    datasets:[{data:curve.map(p=>p.cum),borderColor:color,backgroundColor:grad,fill:true,tension:.25,pointRadius:0,borderWidth:2}]},
    options:chartBase()});
}
function drawCumulative(id, T){
  const el=$('#'+id); if(!el) return;
  const ch=[...T].sort((a,b)=> a.date<b.date?-1: a.date>b.date?1:0);
  let cumR=0, wins=0, counted=0;
  const wrPts=[], expPts=[];
  ch.forEach((t,i)=>{
    cumR+=(t.realizedR||0);
    if(t.result!=='be'){ counted++; if(t.result==='win')wins++; }
    wrPts.push(counted? wins/counted*100 : 0);
    expPts.push(cumR/(i+1));
  });
  charts.cum=new Chart(el,{type:'line',
    data:{labels:ch.map((p,i)=>i+1),datasets:[
      {label:'Winrate %',data:wrPts,borderColor:'#4d9fff',backgroundColor:'transparent',tension:.25,pointRadius:0,borderWidth:2,yAxisID:'y'},
      {label:'Expectancy R',data:expPts,borderColor:'#3ddc84',backgroundColor:'transparent',tension:.25,pointRadius:0,borderWidth:2,yAxisID:'y1'}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#161c27',borderColor:'#1f2733',borderWidth:1,titleColor:'#e8edf4',bodyColor:'#8a97a8',padding:10}},
      scales:{
        x:{grid:{color:'#1f2733'},ticks:{color:'#5a6573',font:{size:10}}},
        y:{position:'left',grid:{color:'#1f2733'},ticks:{color:'#4d9fff',font:{size:10},stepSize:20,callback:v=>Math.round(v)+'%'},min:0,max:100},
        y1:{position:'right',grid:{drawOnChartArea:false},ticks:{color:'#3ddc84',font:{size:10},maxTicksLimit:6,callback:v=>Number(v).toFixed(2)+'R'}}
      }}});
}
function drawDistribution(id, T){
  const el=$('#'+id); if(!el) return;
  const buckets={'<-2R':0,'-2..-1':0,'-1..0':0,'0..1':0,'1..2':0,'>2R':0};
  T.forEach(t=>{const r=t.realizedR||0;
    if(r<-2)buckets['<-2R']++;else if(r<-1)buckets['-2..-1']++;else if(r<0)buckets['-1..0']++;
    else if(r<1)buckets['0..1']++;else if(r<2)buckets['1..2']++;else buckets['>2R']++;});
  const labels=Object.keys(buckets);
  charts.dist=new Chart(el,{type:'bar',data:{labels,
    datasets:[{data:Object.values(buckets),backgroundColor:labels.map(l=>l.includes('-')||l.includes('<')?'#ff5d5d':'#3ddc84'),borderRadius:5}]},
    options:chartBase()});
}

/* ============================================================
   MODAL — TRADE
   ============================================================ */
const FLAG_LABELS={
  clean:'Limpio',
  early_close:'Cierre temprano (miedo)',
  fomo:'Entrada FOMO',
  against_bias:'Contra bias',
  over_max_stops:'Superé máx. stops',
  moved_stop:'Moví el stop',
  revenge:'Revenge trade',
  no_setup:'Sin setup válido',
  oversized:'Sobre-dimensioné',
  bad_analysis:'Error de análisis'
};
// Plan de trading — checklist que aparece al registrar (en catalán, como lo definió Pol)
const PLAN_CHECKLIST=[
  'Tenir el DOL clar i anar només a favor del DOL (Innegociable)',
  'SL on s\u2019invalidi el trade',
  'Tenir rangs LTF (8h-2h) a favor',
  'No tenir rang contrari important a prop',
  'Tend\u00e8ncia a favor',
  '1 SL per compte per dia'
];
const SETUPS=['Setup A','Setup B','Setup C','Pares','Otro'];
const SYMBOLS=['MNQ','MES','MYM','M2K','MGC','MCL','M6E','NQ','ES','YM','GC','CL','EURAUD','Otro'];
const SESSIONS=['Londres','NY','Asia','Overlap'];

function openTradeModal(){ tradeModal(); }
function editTrade(id){ tradeModal(DB.trades.find(t=>t.id===id)); }

function tradeModal(t){
  const e=t||{};
  const flags=e.flags||['clean'];
  const planChecked=e.planChecked||[];
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${t?'Editar trade':'Nuevo trade'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="plan-box">
      <div class="plan-title">📋 Pla de trading — checklist abans d'entrar</div>
      <div id="f_plan">
        ${PLAN_CHECKLIST.map((rule,i)=>`<label class="plan-item">
          <input type="checkbox" data-plan="${i}" ${planChecked.includes(i)?'checked':''}>
          <span>${rule}</span>
        </label>`).join('')}
      </div>
      <div class="plan-count" id="f_planCount"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Fecha</label><input type="date" id="f_date" value="${e.date||todayISO()}"></div>
      <div class="field"><label>Símbolo</label><select id="f_symbol">${SYMBOLS.map(s=>`<option ${(e.symbol||'MNQ')===s?'selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Setup</label><select id="f_setup">${SETUPS.map(s=>`<option ${e.setup===s?'selected':''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>Sesión</label><select id="f_session">${SESSIONS.map(s=>`<option ${e.session===s?'selected':''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>Cuenta</label><select id="f_account"><option value="">— sin asignar —</option>${DB.accounts.map(a=>`<option ${e.account===a.name?'selected':''}>${a.name}</option>`).join('')}</select></div>
    <div class="field-row-3">
      <div class="field"><label>R planificado</label><input type="number" id="f_plannedR" step="0.1" value="${e.plannedR??2}"></div>
      <div class="field"><label>R realizado</label><input type="number" id="f_realizedR" step="0.1" value="${e.realizedR??''}"></div>
      <div class="field"><label>Riesgo ($)</label><input type="number" id="f_riskUSD" value="${e.riskUSD??200}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label>P&L real ($)</label><input type="number" id="f_pnl" value="${e.pnl??''}"></div>
      <div class="field"><label>Resultado (a tu 1:1,5)</label><select id="f_result">
        <option value="win" ${e.result==='win'?'selected':''}>TP (win)</option>
        <option value="loss" ${e.result==='loss'?'selected':''}>SL (loss)</option>
        <option value="be" ${e.result==='be'?'selected':''}>BE</option>
      </select></div>
    </div>
    <div class="field">
      <label>¿Qué habría pasado a 1:1? <span class="hint">(¿el precio tocó tu +1R antes de resolverse?)</span></label>
      <select id="f_result11">
        <option value="" ${!e.result11?'selected':''}>— no registrado —</option>
        <option value="win" ${e.result11==='win'?'selected':''}>TP a 1:1 (habría ganado +1R)</option>
        <option value="loss" ${e.result11==='loss'?'selected':''}>SL a 1:1 (se fue al stop sin tocar 1R)</option>
        <option value="be" ${e.result11==='be'?'selected':''}>BE a 1:1</option>
      </select>
    </div>
    <div class="field"><label>Flags de ejecución (marca lo que pasó)</label>
      <div class="chips" id="f_flags">
        ${Object.entries(FLAG_LABELS).map(([k,l])=>`<button type="button" class="chip ${flags.includes(k)?(k==='clean'?'on good':'on'):''}" data-flag="${k}" onclick="toggleFlag('${k}')">${l}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>Nota</label><textarea id="f_note" rows="2" placeholder="Contexto, qué viste, qué harías distinto...">${e.note||''}</textarea></div>
    <div class="field"><label>Capturas (gráficos, entradas...)</label>
      <div class="img-drop" id="f_imgdrop" onclick="document.getElementById('f_imgInput').click()">📎 Toca para adjuntar imágenes (se comprimen solas)</div>
      <input type="file" id="f_imgInput" accept="image/*" multiple style="display:none" onchange="handleTradeImages(event)">
      <div class="thumb-row" id="f_thumbs"></div>
    </div>
    <div class="modal-actions">
      ${t?`<button class="btn danger" onclick="deleteTrade('${t.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveTrade('${t?t.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  $('#modalBg')._flags=[...flags];
  $('#modalBg')._images=[...(e.images||[])];
  renderTradeThumbs();
  // contador de checklist del plan
  const updatePlanCount=()=>{
    const checked=$$('#f_plan input[type=checkbox]').filter(c=>c.checked).length;
    const total=PLAN_CHECKLIST.length;
    const el=$('#f_planCount');
    if(el) el.innerHTML=`<span class="${checked===total?'pos':checked>=total-1?'':'neg'}">${checked}/${total} reglas cumplidas</span>${checked<total?' — revisa antes de entrar':' ✓ setup A+'}`;
  };
  $$('#f_plan input[type=checkbox]').forEach(c=>c.addEventListener('change',updatePlanCount));
  updatePlanCount();
}

// Comprime una imagen a max 1000px lado mayor, JPEG 0.7 (~100-200KB)
function compressImage(file){
  return new Promise((resolve)=>{
    const reader=new FileReader();
    reader.onload=e=>{
      const img=new Image();
      img.onload=()=>{
        const max=1000;
        let {width,height}=img;
        if(width>max||height>max){
          if(width>height){ height=height*max/width; width=max; }
          else { width=width*max/height; height=max; }
        }
        const canvas=document.createElement('canvas');
        canvas.width=width; canvas.height=height;
        canvas.getContext('2d').drawImage(img,0,0,width,height);
        resolve(canvas.toDataURL('image/jpeg',0.7));
      };
      img.src=e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleTradeImages(ev){
  const files=[...ev.target.files];
  for(const f of files){
    if(!f.type.startsWith('image/')) continue;
    const compressed=await compressImage(f);
    $('#modalBg')._images.push(compressed);
  }
  renderTradeThumbs();
  ev.target.value='';
}
function renderTradeThumbs(){
  const imgs=$('#modalBg')._images||[];
  const c=$('#f_thumbs');
  if(!c) return;
  c.innerHTML=imgs.map((src,i)=>`<div style="position:relative">
    <img class="thumb" src="${src}" onclick="lightbox('${'IMG'+i}')">
    <button onclick="removeTradeImage(${i})" style="position:absolute;top:-6px;right:-6px;background:var(--red);color:#fff;border:none;border-radius:50%;width:20px;height:20px;font-size:12px;cursor:pointer;line-height:1">×</button>
  </div>`).join('');
  // lightbox por índice (evita meter base64 gigante en onclick)
  $$('#f_thumbs .thumb').forEach((el,i)=>{ el.onclick=()=>lightbox(imgs[i]); });
}
function removeTradeImage(i){
  $('#modalBg')._images.splice(i,1);
  renderTradeThumbs();
}
function _modalImagesEnd(){}
function toggleFlag(k){
  const fl=$('#modalBg')._flags;
  if(k==='clean'){ $('#modalBg')._flags=['clean']; }
  else {
    const i=fl.indexOf(k);
    if(i>=0) fl.splice(i,1); else { fl.push(k); const ci=fl.indexOf('clean'); if(ci>=0)fl.splice(ci,1); }
    if(!fl.length) fl.push('clean');
  }
  // refresh chips
  $$('#f_flags .chip').forEach(c=>{
    const fk=c.dataset.flag, on=$('#modalBg')._flags.includes(fk);
    c.className='chip'+(on?(fk==='clean'?' on good':' on'):'');
  });
}
function saveTrade(id){
  const flags=$('#modalBg')._flags;
  const realizedR=parseFloat($('#f_realizedR').value);
  const t={
    id:id||uid(),
    date:$('#f_date').value,
    symbol:$('#f_symbol').value.trim().toUpperCase(),
    setup:$('#f_setup').value,
    session:$('#f_session').value,
    account:$('#f_account').value,
    plannedR:parseFloat($('#f_plannedR').value)||0,
    realizedR:isNaN(realizedR)?0:realizedR,
    riskUSD:parseFloat($('#f_riskUSD').value)||0,
    pnl:parseFloat($('#f_pnl').value)|| ((isNaN(realizedR)?0:realizedR)*(parseFloat($('#f_riskUSD').value)||0)),
    result:$('#f_result').value,
    result11:$('#f_result11').value,
    flags:[...flags],
    note:$('#f_note').value.trim(),
    images:[...($('#modalBg')._images||[])],
    planChecked:$$('#f_plan input[type=checkbox]').filter(c=>c.checked).map(c=>+c.dataset.plan)
  };
  if(id){ const i=DB.trades.findIndex(x=>x.id===id); DB.trades[i]=t; }
  else DB.trades.push(t);
  try{
    save();
  }catch(err){
    // localStorage lleno (probablemente por imágenes)
    toast('⚠ Almacenamiento lleno. Quita alguna imagen o exporta y limpia datos antiguos.');
    if(!id) DB.trades.pop();
    return;
  }
  closeModal(); render(); toast(id?'Trade actualizado':'Trade guardado');
}
function deleteTrade(id){
  if(!confirm('¿Eliminar este trade?'))return;
  DB.trades=DB.trades.filter(t=>t.id!==id); save(); closeModal(); render(); toast('Trade eliminado');
}

/* ============================================================
   MODAL — ACCOUNT
   ============================================================ */
function openAccountModal(){ accountModal(); }
function editAccount(id){ accountModal(DB.accounts.find(a=>a.id===id)); }
function accountModal(a){
  const e=a||{};
  const firms=Object.keys(DB.firms||{});
  const curFirm=e.firm||firms[0]||'LucidFlex';
  const plans=DB.firms[curFirm]?Object.keys(DB.firms[curFirm].plans):[];
  const curPlan=e.plan||plans[0]||'';
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${a?'Editar cuenta':'Nueva cuenta'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field"><label>Nombre/alias</label><input id="a_name" value="${e.name||''}" placeholder="${curFirm} ${curPlan} #1"></div>
    <div class="field-row-3">
      <div class="field"><label>Firma</label><select id="a_firm" onchange="acctFirmChange()">
        ${firms.map(f=>`<option ${curFirm===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="field"><label>Plan</label><select id="a_plan" onchange="acctPreview()">
        ${plans.map(p=>`<option ${curPlan===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
      <div class="field"><label>Fase</label><select id="a_phase" onchange="acctPreview()">
        ${['Evaluación','Funded'].map(p=>`<option ${e.phase===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
    </div>
    <div class="calc-out" id="a_preview" style="margin-bottom:14px"></div>
    <div class="hint">¿Falta tu firma o un plan? Ve a <b>Cuentas → Editar reglas</b> para añadirlo. El balance se calcula con tus trades asignados.</div>
    <div class="modal-actions">
      ${a?`<button class="btn danger" onclick="deleteAccount('${a.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveAccount('${a?a.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  acctPreview();
}
function acctFirmChange(){
  const firm=$('#a_firm').value;
  const plans=DB.firms[firm]?Object.keys(DB.firms[firm].plans):[];
  $('#a_plan').innerHTML=plans.map(p=>`<option>${p}</option>`).join('');
  acctPreview();
}
function acctPreview(){
  const firm=$('#a_firm').value, plan=$('#a_plan').value, phase=$('#a_phase').value;
  const s=planSpec(firm,plan,phase);
  if(!s){ $('#a_preview').innerHTML='<p class="hint">Plan sin reglas definidas.</p>'; return; }
  $('#a_preview').innerHTML=`<div class="grid g-2" style="gap:8px">
    <div class="hint">Balance: <b style="color:var(--ink)">${fmt$(s.size)}</b></div>
    <div class="hint">Drawdown (trailing EOD): <b style="color:var(--ink)">${fmt$(s.drawdown)}</b></div>
    ${s.profitTarget?`<div class="hint">Profit target: <b style="color:var(--ink)">${fmt$(s.profitTarget)}</b></div>`:'<div class="hint">Sin profit target (funded)</div>'}
    ${s.dailyLoss?`<div class="hint">Daily loss limit: <b style="color:var(--red)">${fmt$(s.dailyLoss)}</b></div>`:'<div class="hint">Sin daily loss limit</div>'}
    <div class="hint">Máx contratos: <b style="color:var(--ink)">${s.maxMicro} micros / ${s.maxMini} minis</b></div>
    ${s.consistency?`<div class="hint">Consistency: <b style="color:var(--ink)">${s.consistency}%</b></div>`:'<div class="hint">Sin consistency</div>'}
    ${s.minDays?`<div class="hint">Mín. días: <b style="color:var(--ink)">${s.minDays}</b></div>`:''}
  </div>`;
}
function saveAccount(id){
  const firm=$('#a_firm').value, plan=$('#a_plan').value, phase=$('#a_phase').value;
  const s=planSpec(firm,plan,phase);
  if(!s){ toast('Ese plan no tiene reglas definidas'); return; }
  const a={
    id:id||uid(),
    name:$('#a_name').value.trim()||`${firm} ${plan}`,
    firm, plan, phase,
    size:s.size,
    startBalance:s.size
  };
  if(id){const i=DB.accounts.findIndex(x=>x.id===id);DB.accounts[i]=a;}
  else DB.accounts.push(a);
  save(); closeModal(); render(); toast(id?'Cuenta actualizada':'Cuenta añadida');
}
function deleteAccount(id){
  if(!confirm('¿Eliminar esta cuenta?'))return;
  DB.accounts=DB.accounts.filter(a=>a.id!==id); save(); closeModal(); render(); toast('Cuenta eliminada');
}

function closeModal(){ $('#modalBg').classList.remove('show'); $('#modalBg').innerHTML=''; }

/* ============================================================
   EDITOR DE REGLAS DE FIRMAS
   ============================================================ */
let FE_FIRM=null, FE_PLAN=null;
function openFirmEditor(){
  const firms=Object.keys(DB.firms||{});
  FE_FIRM=FE_FIRM&&DB.firms[FE_FIRM]?FE_FIRM:firms[0];
  const plans=FE_FIRM?Object.keys(DB.firms[FE_FIRM].plans):[];
  FE_PLAN=FE_PLAN&&plans.includes(FE_PLAN)?FE_PLAN:plans[0];
  $('#modalBg').innerHTML=`<div class="modal" style="max-width:640px">
    <h2>⚙ Editar reglas de firmas <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field-row">
      <div class="field"><label>Firma</label><select id="fe_firm" onchange="feSelectFirm(this.value)">
        ${firms.map(f=>`<option ${FE_FIRM===f?'selected':''}>${f}</option>`).join('')}
      </select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:8px">
        <button class="btn ghost sm" onclick="feAddFirm()">+ Firma</button>
        ${firms.length>1?`<button class="btn danger sm" onclick="feDeleteFirm()">Borrar firma</button>`:''}
      </div>
    </div>
    ${FE_FIRM?`
    <div class="field-row">
      <div class="field"><label>Plan</label><select id="fe_plan" onchange="feSelectPlan(this.value)">
        ${plans.map(p=>`<option ${FE_PLAN===p?'selected':''}>${p}</option>`).join('')}
      </select></div>
      <div class="field" style="display:flex;align-items:flex-end;gap:8px">
        <button class="btn ghost sm" onclick="feAddPlan()">+ Plan</button>
        ${plans.length>1?`<button class="btn danger sm" onclick="feDeletePlan()">Borrar plan</button>`:''}
      </div>
    </div>
    <div id="fe_planForm">${FE_PLAN?fePlanForm():''}</div>
    `:'<p class="hint">Añade una firma para empezar.</p>'}
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">Cerrar</button>
      ${FE_PLAN?`<button class="btn primary" onclick="feSavePlan()">Guardar plan</button>`:''}
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
}
function fePlanForm(){
  const p=DB.firms[FE_FIRM].plans[FE_PLAN];
  const trailing=DB.firms[FE_FIRM].trailing||'eod';
  const f=(phase,field,def=0)=> (p[phase]&&p[phase][field]!=null)?p[phase][field]:def;
  const phaseFields=(phase,label)=>`
    <div class="plan-box" style="margin-bottom:12px">
      <div class="plan-title">${label}</div>
      <div class="field-row-3">
        <div class="field"><label>Profit target ($)</label><input type="number" id="fe_${phase}_profitTarget" value="${f(phase,'profitTarget')}"></div>
        <div class="field"><label>Drawdown ($)</label><input type="number" id="fe_${phase}_drawdown" value="${f(phase,'drawdown')}"></div>
        <div class="field"><label>Daily loss ($, 0=no)</label><input type="number" id="fe_${phase}_dailyLoss" value="${f(phase,'dailyLoss')}"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Trail lock ($, 0=no)</label><input type="number" id="fe_${phase}_trailLock" value="${f(phase,'trailLock')}"></div>
        <div class="field"><label>Suelo bloqueado ($)</label><input type="number" id="fe_${phase}_lockedFloor" value="${f(phase,'lockedFloor')}"></div>
        <div class="field"><label>Consistency (%, 0=no)</label><input type="number" id="fe_${phase}_consistency" value="${f(phase,'consistency')}"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Máx micros</label><input type="number" id="fe_${phase}_maxMicro" value="${f(phase,'maxMicro')}"></div>
        <div class="field"><label>Máx minis</label><input type="number" id="fe_${phase}_maxMini" value="${f(phase,'maxMini')}"></div>
        <div class="field"><label>Mín. días</label><input type="number" id="fe_${phase}_minDays" value="${f(phase,'minDays',1)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Mín. profit/día ($)</label><input type="number" id="fe_${phase}_minDailyProfit" value="${f(phase,'minDailyProfit')}"></div>
        <div class="field"><label>Cap payout ($, 0=no)</label><input type="number" id="fe_${phase}_payoutCap" value="${f(phase,'payoutCap')}"></div>
      </div>
    </div>`;
  return `
    <div class="field"><label>Balance del plan ($)</label><input type="number" id="fe_size" value="${p.size||0}"></div>
    ${phaseFields('eval','FASE EVALUACIÓN')}
    ${phaseFields('funded','FASE FUNDED')}
    <div class="hint">Todas trailing EOD. Deja en 0 lo que no aplique (p.ej. sin daily loss, sin consistency, sin trail lock).</div>
  `;
}
function feSelectFirm(name){ FE_FIRM=name; FE_PLAN=null; openFirmEditor(); }
function feSelectPlan(name){ FE_PLAN=name; openFirmEditor(); }
function feAddFirm(){
  const name=prompt('Nombre de la firma nueva:');
  if(!name) return;
  if(DB.firms[name]){ toast('Ya existe'); return; }
  DB.firms[name]={trailing:'eod',plans:{}};
  FE_FIRM=name; FE_PLAN=null; save(); openFirmEditor();
}
function feDeleteFirm(){
  if(!confirm(`¿Borrar la firma ${FE_FIRM} y todos sus planes?`))return;
  delete DB.firms[FE_FIRM]; FE_FIRM=null; FE_PLAN=null; save(); openFirmEditor();
}
function feAddPlan(){
  const name=prompt('Nombre del plan (ej. 50K, Starter 50K...):');
  if(!name) return;
  if(DB.firms[FE_FIRM].plans[name]){ toast('Ya existe'); return; }
  const blank={profitTarget:0,drawdown:0,trailLock:0,lockedFloor:0,dailyLoss:0,maxMicro:0,maxMini:0,minDays:1,consistency:0,minDailyProfit:0,payoutCap:0};
  DB.firms[FE_FIRM].plans[name]={size:0,eval:structuredClone(blank),funded:structuredClone(blank)};
  FE_PLAN=name; save(); openFirmEditor();
}
function feDeletePlan(){
  if(!confirm(`¿Borrar el plan ${FE_PLAN}?`))return;
  delete DB.firms[FE_FIRM].plans[FE_PLAN]; FE_PLAN=null; save(); openFirmEditor();
}
function feSavePlan(){
  const p=DB.firms[FE_FIRM].plans[FE_PLAN];
  p.size=+$('#fe_size').value||0;
  ['eval','funded'].forEach(phase=>{
    p[phase]=p[phase]||{};
    ['profitTarget','drawdown','dailyLoss','trailLock','lockedFloor','consistency','maxMicro','maxMini','minDays','minDailyProfit','payoutCap'].forEach(field=>{
      p[phase][field]=+$(`#fe_${phase}_${field}`).value||0;
    });
  });
  save(); toast('Plan guardado'); render();
}

/* ============================================================
   IMPORT / EXPORT
   ============================================================ */
function exportData(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=`crtdesk-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(url); toast('Datos exportados');
}
function importData(file){
  const r=new FileReader();
  r.onload=()=>{
    try{ const d=JSON.parse(r.result);
      if(d.trades) DB=Object.assign(structuredClone(DEFAULTS),d);
      save(); render(); toast('Datos importados');
    }catch(e){ toast('Archivo inválido'); }
  };
  r.readAsText(file);
}

/* ============================================================
   INIT
   ============================================================ */
function init(){
  $('#tabs').addEventListener('click',e=>{
    const tab=e.target.closest('.tab'); if(!tab)return;
    $$('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    CURRENT_TAB=tab.dataset.tab; render();
  });
  $('#addTradeBtn').onclick=openTradeModal;
  $('#fab').onclick=openTradeModal;
  $('#exportBtn').onclick=exportData;
  $('#importBtn').onclick=()=>$('#fileInput').click();
  $('#fileInput').onchange=e=>{ if(e.target.files[0]) importData(e.target.files[0]); };
  // Cerrar solo si el clic empieza Y termina en el fondo (no al arrastrar desde un input)
  let _downOnBg=false;
  $('#modalBg').addEventListener('mousedown',e=>{ _downOnBg = (e.target.id==='modalBg'); });
  $('#modalBg').addEventListener('mouseup',e=>{ if(_downOnBg && e.target.id==='modalBg') closeModal(); _downOnBg=false; });
  render();
}
init();
