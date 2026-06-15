# CRT Desk — LucidFlex Tracker

Dashboard PWA para tu trading intradía CRT en **LucidFlex** (Lucid Trading). Funciona 100% en el navegador, sin servidor, con persistencia en `localStorage`. Instalable como app en móvil y escritorio. Reglas oficiales de LucidFlex integradas (specs de support.lucidtrading.com, nov 2025–may 2026).

## Reglas LucidFlex que la app conoce

| Tamaño | Profit target | MLL | Trail lock | MLL bloqueado | Máx contratos | Mín profit/día | Cap payout |
|---|---|---|---|---|---|---|---|
| 25K | $1.250 | $1.000 | $26.100 | $25.100 | 2 mini / 20 micro | $100 | $1.000 |
| 50K | $3.000 | $2.000 | $52.100 | $50.100 | 4 mini / 40 micro | $150 | $2.000 |
| 100K | $6.000 | $3.000 | $103.100 | $100.100 | 6 mini / 60 micro | $200 | $2.500 |
| 150K | $9.000 | $4.500 | $154.600 | $150.100 | 10 mini / 100 micro | $250 | $3.000 |

- **Drawdown EOD trailing**: el suelo (MLL) sube con tu balance de cierre hasta el trail lock, luego se bloquea en inicial+$100. **No hay DLL** ni en eval ni en funded.
- **Consistency 50% solo en evaluación** (mayor día / profit total ≤ 50%). En funded no hay consistency.
- **Payout**: split 90/10, mínimo 5 días con profit ≥ el mínimo del plan, neto positivo, mínimo $500, máximo 50% del profit hasta el cap. A las 5 payouts pasas a live.
- **Cierre obligatorio 16:45 EST** (no falla la cuenta, pero te liquidan). Reapertura 18:00 EST dom–jue.

## Qué mide

**Resumen** — Expectancy, winrate, profit factor, R acumulado, max drawdown y el medidor estrella: coste de la indisciplina (R y € perdidos por errores vs. seguir tu plan).

**Disciplina** — Tu expectancy operando limpio vs. con errores, desglose por tipo de error, racha de días limpios.

**Rendimiento** — Breakdown por setup (A vs C-Continuación), sesión, símbolo, día de la semana, distribución de R.

**Sizing — LucidFlex** — Calculadora de contratos sobre tu margen actual hasta el MLL (no DLL, porque LucidFlex no tiene), con tope automático de contratos del plan. Validación de edge con Kelly. Proyección de payout (semanas hasta los 5 días con profit, neto 90%).

**Cuentas & Payouts** — Por cada cuenta: balance, suelo MLL trailing con indicador de bloqueo 🔒, progreso al target (eval) o contador de 5 días con profit (funded), y check de consistency en eval. Las reglas se cargan solas al elegir tamaño.

**Journal** — Registro completo filtrable por limpios/con error.

## Cómo registrar trades

Registra **R planificado** (lo que tu TP/SL daba al entrar) y **R realizado**. La diferencia en trades con flag es tu coste de indisciplina. Asigna cada trade a su cuenta para que balance, MLL y payout se calculen solos. Marca los flags con honestidad.

## Desplegar en GitHub Pages

1. Crea un repo (p. ej. `LucidFlex-CRT`).
2. Sube `index.html`, `app.js`, `manifest.json`.
3. Settings → Pages → Branch `main` / root → Save.
4. Disponible en `https://TUUSUARIO.github.io/LucidFlex-CRT`.
5. En el móvil: abre la URL → "Añadir a pantalla de inicio".

## Backup

Botón ⤓ exporta tus datos a JSON. Botón ⤒ los reimporta. Hazlo periódicamente: `localStorage` se borra si limpias datos del navegador.

## Nota

Las reglas pueden cambiar. Si LucidFlex actualiza specs, edita el objeto `LUCIDFLEX` al principio de `app.js`.
