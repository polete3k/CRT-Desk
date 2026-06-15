/* ============================================================
   CRT Desk — Futures Prop Tracker
   Motor de métricas + UI. Persistencia en localStorage.
   ============================================================ */

const STORE_KEY = 'crtdesk_v1';

// ---- Especificaciones oficiales LucidFlex (support.lucidtrading.com, nov2025-may2026) ----
const LUCIDFLEX = {
  25000:  { profitTarget:1250, mll:1000, trailLock:26100,  lockedMLL:25100,  maxMini:2,  maxMicro:20,  minDailyProfit:100, payoutCap:1000 },
  50000:  { profitTarget:3000, mll:2000, trailLock:52100,  lockedMLL:50100,  maxMini:4,  maxMicro:40,  minDailyProfit:150, payoutCap:2000 },
  100000: { profitTarget:6000, mll:3000, trailLock:103100, lockedMLL:100100, maxMini:6,  maxMicro:60,  minDailyProfit:200, payoutCap:2500 },
  150000: { profitTarget:9000, mll:4500, trailLock:154600, lockedMLL:150100, maxMini:10, maxMicro:100, minDailyProfit:250, payoutCap:3000 }
};
const LUCID_RULES = {
  profitSplit: 0.90,            // 90/10
  consistencyEval: 0.50,        // 50% máx día/total SOLO en eval
  consistencyFunded: null,      // sin consistency en funded
  payoutDaysRequired: 5,        // 5 días con profit mínimo
  payoutMin: 500,
  payoutsBeforeLive: 5,
  closeBy: '16:45 EST',
  noDLL: true
};

const DEFAULTS = {
  trades: [],
  accounts: [],
  settings: { dailyRiskUSD: 400, riskPerTradePct: 25 }, // límite propio opcional; sizing va sobre margen MLL
  meta: { created: Date.now() }
};

let DB = load();

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return structuredClone(DEFAULTS);
    return Object.assign(structuredClone(DEFAULTS), JSON.parse(raw));
  }catch(e){ return structuredClone(DEFAULTS); }
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

function tradesFiltered(filterFn){
  return DB.trades.filter(filterFn||(()=>true)).sort((a,b)=> a.date<b.date?1:-1);
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
  if(CURRENT_TAB!=='accounts' && CURRENT_TAB!=='capital' && !T.length){
    v.innerHTML = emptyState();
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
}

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
        <h3>Rendimiento por setup</h3>
        ${breakdownTable(breakdown(T,'setup'))}
      </div>
    </div>

    ${autoInsights(T)}
  `;
  drawEquity('equityChart', T);
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
function renderCapital(v, T){
  const k = kellyFraction(T);
  const halfK = k/2, quarterK = k/4;
  const exp = expectancy(T);

  // micros más operados por traders CRT: MES, MNQ, M6E (EUR). Tabla de tick values.
  v.innerHTML=`
    <div class="section-title">Sizing — LucidFlex</div>

    <div class="insight" style="margin-bottom:16px">
      <b>LucidFlex no tiene DLL.</b> Tu única restricción de pérdida es el <b>MLL (Max Loss Limit)</b> con drawdown End-of-Day: el suelo sube con tu balance de cierre hasta el trail y luego se bloquea en inicial+$100. El sizing aquí se calcula sobre tu <b>margen actual hasta el MLL</b>, no sobre un límite diario.
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3>Calculadora de sizing por margen al MLL</h3>
      <div class="field-row-3">
        <div class="field"><label>Cuenta LucidFlex</label><select id="szAcct" onchange="calcSize()">
          <option value="25000">25K</option>
          <option value="50000" selected>50K</option>
          <option value="100000">100K</option>
          <option value="150000">150K</option>
        </select></div>
        <div class="field"><label>Balance de cierre actual ($)</label><input type="number" id="szBal" value="50000" oninput="calcSize()"></div>
        <div class="field"><label>Riesgo máx. por trade (% del margen)</label><input type="number" id="szPct" value="25" oninput="calcSize()"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>Stop (ticks)</label><input type="number" id="szTicks" value="20" oninput="calcSize()"></div>
        <div class="field"><label>Valor del tick ($)</label><input type="number" id="szTickVal" value="1.25" step="0.01" oninput="calcSize()"></div>
        <div class="field"><label>Máx. stops/sesión</label><input type="number" id="szMaxStops" value="2" oninput="calcSize()"></div>
      </div>
      <div class="hint" style="margin:-4px 0 12px">Tick values comunes: MES $1.25 · MNQ $0.50 · M6E (Euro micro) $1.25 · ES $12.50 · NQ $5.00</div>
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
      <h3>Proyección de payout LucidFlex</h3>
      <div class="field-row-3">
        <div class="field"><label>Cuenta</label><select id="pjAcct" onchange="calcPayout()">
          <option value="25000">25K</option>
          <option value="50000" selected>50K</option>
          <option value="100000">100K</option>
          <option value="150000">150K</option>
        </select></div>
        <div class="field"><label>Profit medio/día ganador ($)</label><input type="number" id="pjDaily" value="300" oninput="calcPayout()"></div>
        <div class="field"><label>Días ganadores/semana</label><input type="number" id="pjDays" value="3" oninput="calcPayout()"></div>
      </div>
      <div class="calc-out" id="pjOut"></div>
    </div>
  `;
  calcSize(); calcPayout();
}

function calcSize(){
  const size=+$('#szAcct').value;
  const spec=LUCIDFLEX[size];
  const bal=+$('#szBal').value||0, pct=+$('#szPct').value||0, ticks=+$('#szTicks').value||0,
        tv=+$('#szTickVal').value||0, maxStops=+$('#szMaxStops').value||1;
  // suelo MLL trailing: balance - mll, bloqueado en lockedMLL una vez supera el trail
  const floor = bal>=spec.trailLock ? spec.lockedMLL : (bal - spec.mll);
  const room = bal - floor;               // margen hasta breach
  const riskPerTrade = room*(pct/100);
  const riskPerContract = ticks*tv;
  const contractsRaw = riskPerContract? Math.floor(riskPerTrade/riskPerContract):0;
  const contracts = Math.max(0, Math.min(contractsRaw, spec.maxMicro)); // tope de contratos del plan
  const cappedByPlan = contractsRaw>spec.maxMicro;
  const actualRisk = contracts*riskPerContract;
  const ifMaxStops = actualRisk*maxStops;
  const safe = ifMaxStops <= room;
  $('#szOut').innerHTML=`
    <div class="grid g-4" style="gap:10px">
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">MARGEN AL MLL</div><div class="big">${fmt$(room)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">RIESGO/TRADE</div><div class="big">${fmt$(riskPerTrade)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">CONTRATOS (micros)</div><div class="big" style="color:var(--green)">${contracts}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">RIESGO REAL</div><div class="big">${fmt$(actualRisk)}</div></div>
    </div>
    <hr class="sep">
    <div class="hint">Suelo MLL actual: <b>${fmt$(floor)}</b>${bal>=spec.trailLock?' (bloqueado ✓)':' (aún trailing)'} · Tope del plan: ${spec.maxMicro} micros / ${spec.maxMini} minis</div>
    ${cappedByPlan?`<div class="hint dd-warn" style="margin-top:6px">El cálculo pedía más contratos, pero el plan ${size/1000}K limita a ${spec.maxMicro} micros. Tamaño recortado al máximo permitido.</div>`:''}
    <div class="hint ${safe?'':'dd-warn'}" style="margin-top:6px">Con ${maxStops} stops seguidos perderías <b>${fmt$(ifMaxStops)}</b> ${safe?`— dentro de tu margen de ${fmt$(room)}. ✓`:`— ¡te acerca peligrosamente al MLL! Reduce % o stop.`}</div>
  `;
}

function calcPayout(){
  const size=+$('#pjAcct').value;
  const spec=LUCIDFLEX[size];
  const daily=+$('#pjDaily').value||0, daysWk=+$('#pjDays').value||0;
  const meetsMin = daily>=spec.minDailyProfit;
  // semanas hasta cumplir 5 días con profit mínimo
  const qualDaysPerWk = Math.min(daysWk, daysWk); // días que cumplen el mínimo = los ganadores si daily>=min
  const weeksToPayout = meetsMin && qualDaysPerWk>0 ? Math.ceil(LUCID_RULES.payoutDaysRequired/qualDaysPerWk) : Infinity;
  const cycleProfit = daily*daysWk*(weeksToPayout===Infinity?0:weeksToPayout);
  const grossPayout = Math.min(cycleProfit*0.5, spec.payoutCap); // 50% del profit hasta el cap
  const netPayout = grossPayout*LUCID_RULES.profitSplit;          // 90/10
  $('#pjOut').innerHTML=`
    <div class="grid g-3" style="gap:10px">
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">SEMANAS AL 1er PAYOUT</div><div class="big">${weeksToPayout===Infinity?'—':weeksToPayout}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">PAYOUT BRUTO (máx)</div><div class="big">${fmt$(grossPayout)}</div></div>
      <div><div class="label" style="font-size:10px;color:var(--ink-faint)">NETO (90%)</div><div class="big" style="color:var(--green)">${fmt$(netPayout)}</div></div>
    </div>
    <hr class="sep">
    <div class="hint ${meetsMin?'':'dd-warn'}">${meetsMin
      ? `Tus días ganadores superan el mínimo de ${fmt$(spec.minDailyProfit)}/día. Necesitas 5 días con profit + neto positivo para pedir payout. Cap de retirada: ${fmt$(spec.payoutCap)} (50% del profit). A las 5 payouts pasas a live.`
      : `⚠ ${fmt$(daily)}/día no llega al mínimo de ${fmt$(spec.minDailyProfit)} que LucidFlex exige para contar como "día con profit" en el ${size/1000}K.`}</div>
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
      <button class="btn primary sm" onclick="openAccountModal()">+ Cuenta</button>
    </div>
    ${!accts.length?`<div class="empty"><div class="ico">▤</div><p class="hint">Sin cuentas. Añade tu LucidFlex (25K/50K/100K/150K) y las reglas se cargan solas.</p><button class="btn primary" style="margin-top:14px" onclick="openAccountModal()">+ Añadir LucidFlex</button></div>`:
    accts.map(a=>{
      const spec = LUCIDFLEX[a.size]||{};
      const aTrades = T.filter(t=>t.account===a.name);
      const realized = totalPnl(aTrades);
      const balance = (a.startBalance||0)+realized;
      // MLL trailing EOD: sube con balance hasta trailLock, luego se bloquea en lockedMLL
      const floor = balance>=(a.trailLock||spec.trailLock) ? (a.lockedMLL||spec.lockedMLL) : (balance - (a.maxDD||spec.mll));
      const ddRoom = balance - floor;
      const ddPct = (a.maxDD||spec.mll)? Math.max(0,Math.min(100, ddRoom/(a.maxDD||spec.mll)*100)) : 0;
      const locked = balance>=(a.trailLock||spec.trailLock);
      const targetRoom = a.phase==='Evaluación'? a.startBalance+a.target - balance : 0;
      const targetPct = a.phase==='Evaluación'&&a.target? Math.max(0,Math.min(100, realized/a.target*100)) : 0;

      // payout tracking: días distintos con profit >= minDailyProfit
      const profitByDay={};
      aTrades.forEach(t=>{ profitByDay[t.date]=(profitByDay[t.date]||0)+(t.pnl||0); });
      const qualDays = Object.values(profitByDay).filter(p=>p>=spec.minDailyProfit).length;
      const payoutReady = qualDays>=LUCID_RULES.payoutDaysRequired && realized>0;

      // consistency (solo eval): mayor día / profit total
      const dayProfits=Object.values(profitByDay).filter(p=>p>0);
      const maxDay=dayProfits.length?Math.max(...dayProfits):0;
      const consistency = realized>0? maxDay/realized*100 : 0;
      const consistencyOK = consistency<=50;

      return `<div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">
          <div>
            <div style="font-size:15px;font-weight:700">${a.name}</div>
            <div class="acct-meta">LucidFlex ${a.size/1000}K · ${a.phase} · EOD trailing · ${aTrades.length} trades</div>
          </div>
          <div style="display:flex;gap:6px">
            <span class="tag ${ddPct>40?'ok':ddPct>20?'warn':'bad'}">MLL ${fmt(ddPct,0)}%</span>
            <button class="btn ghost sm icon" onclick="editAccount('${a.id}')" title="Editar">✎</button>
          </div>
        </div>
        <div class="grid g-3" style="gap:10px;margin-bottom:14px">
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">BALANCE</div><div style="font-family:var(--mono);font-size:18px;font-weight:700">${fmt$(balance)}</div></div>
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">P&L</div><div style="font-family:var(--mono);font-size:18px;font-weight:700" class="${cls(realized)}">${fmt$(realized)}</div></div>
          <div><div class="label" style="font-size:10px;color:var(--ink-faint)">SUELO MLL ${locked?'🔒':''}</div><div style="font-family:var(--mono);font-size:18px;font-weight:700">${fmt$(floor)}</div></div>
        </div>
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Margen hasta MLL (breach)</span><span style="font-family:var(--mono)">${fmt$(ddRoom)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${ddPct}%;background:${ddPct>40?'var(--green)':ddPct>20?'var(--amber)':'var(--red)'}"></div></div>
        </div>
        ${a.phase==='Evaluación'?`
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Progreso al profit target</span><span style="font-family:var(--mono)">${fmt(targetPct,0)}% · faltan ${fmt$(Math.max(0,targetRoom))}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${targetPct}%;background:var(--blue)"></div></div>
        </div>
        <div class="insight ${consistencyOK?'':'warn'}" style="margin-top:10px">Consistency (eval): tu mayor día es <b>${fmt(consistency,0)}%</b> del profit total. ${consistencyOK?'Bajo el 50% ✓ — puedes subir a funded al llegar al target.':'⚠ Supera el 50%: sigue operando para repartir el profit antes de poder pasar a funded.'}</div>
        `:`
        <div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ink-dim);margin-bottom:2px"><span>Días con profit para payout (≥${fmt$(spec.minDailyProfit)})</span><span style="font-family:var(--mono)">${qualDays} / 5</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.min(100,qualDays/5*100)}%;background:${payoutReady?'var(--green)':'var(--violet)'}"></div></div>
        </div>
        <div class="insight ${payoutReady?'':''}" style="margin-top:10px">${payoutReady
          ? `✓ <b>Payout disponible.</b> Tienes ${qualDays} días con profit y neto positivo. Puedes retirar hasta ${fmt$(spec.payoutCap)} (50% del profit), neto 90%. Recuerda: a las 5 payouts pasas a live.`
          : `Te faltan <b>${Math.max(0,5-qualDays)} días</b> con profit ≥ ${fmt$(spec.minDailyProfit)} para poder pedir payout. Sin consistency rule en funded.`}</div>
        `}
      </div>`;
    }).join('')}
    ${accts.length?`<div class="insight" style="margin-top:6px"><b>MLL EOD de LucidFlex:</b> el suelo sube con tu balance de cierre hasta el trail lock y entonces se bloquea en inicial+$100 (🔒). No hay DLL: dentro del día solo importa no tocar el suelo al cierre. Cierre obligatorio 16:45 EST (no falla la cuenta, pero te liquidan posiciones abiertas).</div>`:''}
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
  'Si és NY, plantejar abans els possibles escenaris',
  'SL on s\u2019invalidi el trade',
  'Tenir BIAS a favor (12h-4h)',
  'No tenir rang contrari a prop',
  'Tendència a favor',
  'No Inside candle'
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
      <div class="field"><label>Resultado</label><select id="f_result">
        <option value="win" ${e.result==='win'?'selected':''}>Win</option>
        <option value="loss" ${e.result==='loss'?'selected':''}>Loss</option>
        <option value="be" ${e.result==='be'?'selected':''}>Break-even</option>
      </select></div>
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
  const size=e.size||50000;
  $('#modalBg').innerHTML=`<div class="modal">
    <h2>${a?'Editar cuenta':'Nueva cuenta LucidFlex'} <button class="btn ghost sm icon" onclick="closeModal()">✕</button></h2>
    <div class="field-row">
      <div class="field"><label>Nombre/alias</label><input id="a_name" value="${e.name||''}" placeholder="LucidFlex 50K #1"></div>
      <div class="field"><label>Tamaño</label><select id="a_size" onchange="lucidPreview()">
        ${[25000,50000,100000,150000].map(s=>`<option value="${s}" ${size===s?'selected':''}>${s/1000}K</option>`).join('')}
      </select></div>
    </div>
    <div class="field"><label>Fase</label><select id="a_phase">
      ${['Evaluación','Funded'].map(p=>`<option ${e.phase===p?'selected':''}>${p}</option>`).join('')}
    </select></div>
    <div class="calc-out" id="a_preview" style="margin-bottom:14px"></div>
    <div class="hint">Las reglas (profit target, MLL, consistency, contratos) se cargan automáticamente desde las specs oficiales de LucidFlex. El balance actual se calcula con tus trades asignados.</div>
    <div class="modal-actions">
      ${a?`<button class="btn danger" onclick="deleteAccount('${a.id}')">Eliminar</button>`:''}
      <button class="btn ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="saveAccount('${a?a.id:''}')">Guardar</button>
    </div>
  </div>`;
  $('#modalBg').classList.add('show');
  lucidPreview();
}
function lucidPreview(){
  const size=+$('#a_size').value, s=LUCIDFLEX[size];
  $('#a_preview').innerHTML=`<div class="grid g-2" style="gap:8px">
    <div class="hint">Profit target: <b style="color:var(--ink)">${fmt$(s.profitTarget)}</b></div>
    <div class="hint">MLL: <b style="color:var(--ink)">${fmt$(s.mll)}</b></div>
    <div class="hint">Trail lock: <b style="color:var(--ink)">${fmt$(s.trailLock)}</b></div>
    <div class="hint">Máx contratos: <b style="color:var(--ink)">${s.maxMicro} micros / ${s.maxMini} minis</b></div>
    <div class="hint">Mín. profit/día: <b style="color:var(--ink)">${fmt$(s.minDailyProfit)}</b></div>
    <div class="hint">Cap payout: <b style="color:var(--ink)">${fmt$(s.payoutCap)}</b></div>
  </div>`;
}
function saveAccount(id){
  const size=+$('#a_size').value, s=LUCIDFLEX[size];
  const a={
    id:id||uid(),
    name:$('#a_name').value.trim()||`LucidFlex ${size/1000}K`,
    firm:'LucidFlex',
    size,
    startBalance:size,
    maxDD:s.mll,
    target:s.profitTarget,
    ddType:'trailing',
    trailLock:s.trailLock,
    lockedMLL:s.lockedMLL,
    phase:$('#a_phase').value
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
