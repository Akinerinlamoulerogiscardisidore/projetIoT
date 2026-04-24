/**
 * ══════════════════════════════════════════════════════════════════
 *  SmartHome Sentinel V2.0 · app.js
 *  Raven Lab × Moov Africa 5G
 *
 *  RÔLE : Interface de VISUALISATION PURE (lecture seule)
 *  ──────────────────────────────────────────────────────
 *  ✔ Lit SIL/telemetrie en temps réel (listener Firebase)
 *  ✔ Affiche temp, hum, pression, iaq, co2, lux
 *  ✔ Micro-animations à chaque mise à jour de valeur
 *  ✔ Sparklines par capteur (Chart.js léger)
 *  ✔ Graphique principal Temp + Humidité
 *  ✔ Journal d'événements horodaté
 *  ✔ Mode démo si Firebase non disponible
 *
 *  AUCUNE commande, AUCUN bouton, AUCUN mode auto/manuel.
 * ══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ──────────────────────────────────────────────────────────────────
   1. CONFIGURATION FIREBASE
────────────────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyC3v3xktfmWzzNE0mjOKW9mtSeUoTPQpE4',
  authDomain:        'sentinelle-sil.firebaseapp.com',
  databaseURL:       'https://sentinelle-sil-default-rtdb.firebaseio.com',
  projectId:         'sentinelle-sil',
  storageBucket:     'sentinelle-sil.firebasestorage.app',
  messagingSenderId: '621756722754',
  appId:             '1:621756722754:web:8e9b196ae97d13686cc7db'
};

// Chemin racine (lecture seule)
const DB_PATH = 'SIL/telemetrie';


/* ──────────────────────────────────────────────────────────────────
   2. SEUILS & CONFIGURATION
────────────────────────────────────────────────────────────────── */
const CONFIG = {
  thresholds: {
    temp: { warn: 28,   danger: 35   },
    hum:  { warn: 65,   danger: 80   },
    iaq:  { warn: 100,  danger: 200  },
    co2:  { warn: 1000, danger: 2000 }
  },
  chart:   { maxPoints: 40 },
  spark:   { maxPoints: 20 },
  history: { maxItems: 60 },
  demo:    { enabled: true, interval: 4000 }
};


/* ──────────────────────────────────────────────────────────────────
   3. ÉTAT CENTRALISÉ
────────────────────────────────────────────────────────────────── */
const STATE = {
  firebase:   { connected: false, db: null },
  sensors: {
    temperature: null,
    humidity:    null,
    pressure:    null,
    light:       null,
    iaq:         null,
    co2:         null,
    lastUpdate:  null
  },
  prevSensors: {},
  chart: { labels: [], tempData: [], humData: [] },
  sparks: {
    temp: [], hum: [], lux: []
  },
  log: []
};


/* ──────────────────────────────────────────────────────────────────
   4. INITIALISATION FIREBASE
────────────────────────────────────────────────────────────────── */

function initFirebase() {
  try {
    const app = firebase.initializeApp(FIREBASE_CONFIG);
    STATE.firebase.db = firebase.database(app);

    // Indicateur de connexion
    firebase.database().ref('.info/connected').on('value', snap => {
      const ok = snap.val() === true;
      STATE.firebase.connected = ok;
      updateConnStatus(ok);
    });

    // Listener temps réel sur SIL/telemetrie
    STATE.firebase.db.ref(DB_PATH).on('value', snap => {
      const data = snap.val();
      if (data) onNewData(data);
    }, err => {
      console.error('[Sentinel] Erreur Firebase:', err);
      updateConnStatus(false);
      if (CONFIG.demo.enabled) startDemoMode();
    });

  } catch (err) {
    console.error('[Sentinel] Erreur initialisation Firebase:', err);
    updateConnStatus(false);
    if (CONFIG.demo.enabled) startDemoMode();
  }
}

function updateConnStatus(ok) {
  const pill  = el('firebase-status');
  const dot   = el('firebase-dot');
  const label = el('firebase-label');
  if (!pill) return;
  pill.classList.toggle('connected',    ok);
  pill.classList.toggle('disconnected', !ok);
  if (label) label.textContent = ok ? 'Connexion réussie' : 'Déconnecté';

  // Badge LIVE 5G : opacité réduite si déconnecté
  const badge = el('badge-live');
  if (badge) badge.style.opacity = ok ? '1' : '0.45';
}


/* ──────────────────────────────────────────────────────────────────
   5. RÉCEPTION & TRAITEMENT DES DONNÉES
────────────────────────────────────────────────────────────────── */

function onNewData(data) {
  // Sauvegarder les valeurs précédentes pour les tendances
  STATE.prevSensors = { ...STATE.sensors };

  // Mapping des clés Firebase → état local
  // La clé "pression" (et non "pres") est utilisée pour la pression
  STATE.sensors.temperature = data.temp     !== undefined ? parseFloat(data.temp)    : null;
  STATE.sensors.humidity    = data.hum      !== undefined ? parseFloat(data.hum)     : null;
  STATE.sensors.pressure    = data.pression !== undefined ? parseFloat(data.pression): null;
  STATE.sensors.light       = data.lux      !== undefined ? parseFloat(data.lux)     : null;
  STATE.sensors.iaq         = data.iaq      !== undefined ? parseFloat(data.iaq)     : null;
  STATE.sensors.co2         = data.co2      !== undefined ? parseFloat(data.co2)     : null;
  STATE.sensors.lastUpdate  = new Date();

  // Rendu de toutes les cartes
  renderAll();

  // Graphique historique + sparklines
  updateMainChart();
  updateSparklines();

  // Journal
  logUpdate();

  // Timestamp
  const tsEl = el('last-update-time');
  if (tsEl) tsEl.textContent = STATE.sensors.lastUpdate.toLocaleTimeString('fr-FR');
}


/* ──────────────────────────────────────────────────────────────────
   6. RENDU COMPLET
────────────────────────────────────────────────────────────────── */

function renderAll() {
  renderTemp();
  renderHum();
  renderPres();
  renderIAQ();
  renderLux();
  renderGlobalStatus();
}


/* ── Température ──────────────────────────────────────────────── */
function renderTemp() {
  const v = STATE.sensors.temperature;
  const { warn, danger } = CONFIG.thresholds.temp;
  const card  = el('card-temp');
  const valEl = el('temp-value');
  const dotEl = el('temp-state-dot');

  if (!card || !valEl) return;

  if (v === null) { valEl.textContent = '–'; return; }

  // Animation de mise à jour
  animateValue(valEl, v.toFixed(1));

  // État colorimétrique
  const state = v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok';
  applyCardState(card, dotEl, state);

  // Tendance
  renderTrend('temp-trend', v, STATE.prevSensors.temperature, '°C');

  // Sparkline data
  pushSparkData('temp', v);
}


/* ── Humidité ─────────────────────────────────────────────────── */
function renderHum() {
  const v = STATE.sensors.humidity;
  const { warn, danger } = CONFIG.thresholds.hum;
  const card  = el('card-hum');
  const valEl = el('hum-value');
  const dotEl = el('hum-state-dot');
  const barEl = el('hum-bar');

  if (!card || !valEl) return;
  if (v === null) { valEl.textContent = '–'; return; }

  animateValue(valEl, v.toFixed(1));

  const state = v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok';
  applyCardState(card, dotEl, state);

  // Barre de progression
  if (barEl) {
    barEl.style.width = Math.min(100, Math.max(0, v)) + '%';
    barEl.style.background = state === 'danger' ? 'linear-gradient(90deg,#ef4444,#f97316)'
                           : state === 'warn'   ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
                           : 'linear-gradient(90deg,#3b82f6,#06b6d4)';
  }

  renderTrend('hum-trend', v, STATE.prevSensors.humidity, '%');
  pushSparkData('hum', v);
}


/* ── Pression ─────────────────────────────────────────────────── */
function renderPres() {
  const v = STATE.sensors.pressure;
  const card  = el('card-pres');
  const valEl = el('pres-value');
  const centerLabel = el('pres-center-label');

  if (!card || !valEl) return;
  if (v === null) { valEl.textContent = '–'; return; }

  animateValue(valEl, v.toFixed(1));

  // Pas de seuil critique pour la pression — toujours "ok"
  const dotEl = el('pres-state-dot');
  applyCardState(card, dotEl, 'ok');

  // Mise à jour du label central de la jauge
  if (centerLabel) centerLabel.textContent = v.toFixed(0);

  // Jauge analogique : 950–1050 hPa → 0°–180°
  const minP = 950, maxP = 1050;
  const clampedV = Math.min(maxP, Math.max(minP, v));
  const ratio    = (clampedV - minP) / (maxP - minP);
  const angleDeg = ratio * 180 - 90; // -90° à +90°

  const needle = el('pres-needle');
  if (needle) needle.style.transform = `rotate(${angleDeg}deg)`;

  // Arc SVG : arc partiel selon ratio
  const arcEl = el('pres-arc');
  if (arcEl) {
    const totalLen  = 173;   // longueur de l'arc demi-cercle (≈π×r)
    const dashOffset = totalLen - ratio * totalLen;
    arcEl.style.strokeDashoffset = dashOffset;
    arcEl.style.stroke = ratio > 0.7 ? '#F78F1E' : ratio < 0.3 ? '#8b5cf6' : '#005DAA';
  }

  renderTrend('pres-trend', v, STATE.prevSensors.pressure, ' hPa');
}


/* ── Qualité de l'air (IAQ + CO₂) ─────────────────────────────── */
function renderIAQ() {
  const iaq = STATE.sensors.iaq;
  const co2 = STATE.sensors.co2;
  const card  = el('card-iaq');
  const iaqEl = el('iaq-value');
  const co2El = el('co2-value');
  const badge = el('iaq-badge');
  const bar   = el('iaq-color-bar');
  const icon  = el('iaq-icon');
  const marker = el('iaq-marker');

  if (!card || !iaqEl) return;

  // CO₂
  if (co2El) {
    co2El.textContent = co2 !== null ? co2.toFixed(0) : '–';
    animateValue(co2El, co2 !== null ? co2.toFixed(0) : '–');
    co2El.style.color = co2 !== null && co2 >= CONFIG.thresholds.co2.danger ? '#dc2626'
                       : co2 !== null && co2 >= CONFIG.thresholds.co2.warn  ? '#d97706'
                       : '';
  }

  if (iaq === null) { iaqEl.textContent = '–'; return; }
  animateValue(iaqEl, iaq.toFixed(0));

  // Classification IAQ
  let quality, badgeCls, barGradient, markerPct;
  if      (iaq <= 50)  { quality = 'EXCELLENT'; badgeCls = 'air-badge--excellent'; barGradient = 'linear-gradient(90deg,#22c55e,#22c55e)'; markerPct = (iaq / 500) * 100; }
  else if (iaq <= 100) { quality = 'BON';        badgeCls = 'air-badge--good';      barGradient = 'linear-gradient(90deg,#22c55e,#84cc16)'; markerPct = (iaq / 500) * 100; }
  else if (iaq <= 150) { quality = 'MODÉRÉ';     badgeCls = 'air-badge--moderate';  barGradient = 'linear-gradient(90deg,#eab308,#f97316)'; markerPct = (iaq / 500) * 100; }
  else if (iaq <= 200) { quality = 'DÉGRADÉ';    badgeCls = 'air-badge--moderate';  barGradient = 'linear-gradient(90deg,#f97316,#ef4444)'; markerPct = (iaq / 500) * 100; }
  else                 { quality = 'MAUVAIS';    badgeCls = 'air-badge--poor';      barGradient = 'linear-gradient(90deg,#ef4444,#991b1b)'; markerPct = Math.min(99, (iaq / 500) * 100); }

  if (badge) {
    badge.textContent = quality;
    badge.className   = 'air-quality-badge ' + badgeCls;
  }

  // Marqueur sur le spectre
  if (marker) marker.style.left = markerPct + '%';

  // Barre colorée dynamique
  if (bar) bar.style.background = barGradient;

  // Couleur de l'icône air
  if (icon) {
    icon.style.background = iaq > 150 ? '#fee2e2' : iaq > 100 ? '#fef3c7' : '#f0fdf4';
    icon.style.color      = iaq > 150 ? '#dc2626' : iaq > 100 ? '#d97706' : '#16a34a';
  }

  // État de la carte
  const state = iaq >= 200 ? 'danger' : iaq >= 100 ? 'warn' : 'ok';
  const dotEl = el('iaq-dot');
  applyCardState(card, dotEl, state);

  renderTrend('iaq-trend', iaq, STATE.prevSensors.iaq, ' IAQ');
}


/* ── Luminosité ─────────────────────────────────────────────────── */
function renderLux() {
  const v = STATE.sensors.light;
  const card  = el('card-lux');
  const valEl = el('lux-value');
  const dotEl = el('lux-state-dot');
  const bar   = el('lux-bar');
  const sun   = el('lux-sun');

  if (!card || !valEl) return;
  if (v === null) { valEl.textContent = '–'; return; }

  animateValue(valEl, v < 10 ? v.toFixed(1) : Math.round(v).toString());

  // Toujours OK (pas de seuil d'alerte pour la luminosité)
  applyCardState(card, dotEl, 'ok');

  // Barre de luminosité : 0–2000 lux considérés plein soleil
  const pct = Math.min(100, (v / 2000) * 100);
  if (bar) bar.style.width = pct + '%';

  // Opacité du soleil proportionnelle à la luminosité
  if (sun) sun.style.opacity = Math.max(0.2, Math.min(1, v / 800)).toString();

  renderTrend('lux-trend', v, STATE.prevSensors.light, ' lux');
  pushSparkData('lux', v);
}


/* ──────────────────────────────────────────────────────────────────
   7. STATUT GLOBAL (bande d'info)
────────────────────────────────────────────────────────────────── */

function renderGlobalStatus() {
  const { temperature, humidity, iaq } = STATE.sensors;
  const thr = CONFIG.thresholds;
  const label = el('global-status-label');
  if (!label) return;

  const isDanger = (temperature !== null && temperature >= thr.temp.danger)
                || (humidity    !== null && humidity    >= thr.hum.danger)
                || (iaq         !== null && iaq         >= thr.iaq.danger);
  const isWarn   = (temperature !== null && temperature >= thr.temp.warn)
                || (humidity    !== null && humidity    >= thr.hum.warn)
                || (iaq         !== null && iaq         >= thr.iaq.warn);

  if (isDanger)                          { label.textContent = '⚠ Critique'; label.style.color = '#dc2626'; }
  else if (isWarn)                       { label.textContent = '⚡ Alerte';   label.style.color = '#d97706'; }
  else if (temperature !== null)         { label.textContent = '✓ Nominal';  label.style.color = '#16a34a'; }
  else                                   { label.textContent = 'Attente…';  label.style.color = ''; }
}


/* ──────────────────────────────────────────────────────────────────
   8. HELPERS VISUELS
────────────────────────────────────────────────────────────────── */

/**
 * Animation de mise à jour de valeur : pop + fondu.
 * Ne re-joue l'animation que si la valeur a changé.
 */
function animateValue(el, newText) {
  if (!el || el.textContent === newText) return;
  el.textContent = newText;
  el.classList.remove('value-pop');
  // Force reflow pour relancer l'animation CSS
  void el.offsetWidth;
  el.classList.add('value-pop');
}

/**
 * Applique la classe d'état (ok/warn/danger) à la carte et au point de statut.
 */
function applyCardState(card, dotEl, state) {
  card.classList.remove('state-ok', 'state-warn', 'state-danger');
  card.classList.add('state-' + state);

  if (dotEl) {
    dotEl.classList.remove('card-status-dot--ok', 'card-status-dot--warn', 'card-status-dot--danger');
    dotEl.classList.add('card-status-dot--' + state);
  }
}

/**
 * Affiche un indicateur de tendance (↑ hausse / ↓ baisse).
 */
function renderTrend(trendId, current, prev, unit) {
  const el2 = el(trendId);
  if (!el2 || prev === null || prev === undefined) return;
  const diff = current - prev;
  if (Math.abs(diff) < 0.05) { el2.textContent = ''; return; }

  const arrow = diff > 0 ? '↑' : '↓';
  const sign  = diff > 0 ? '+' : '';
  el2.textContent = `${arrow} ${sign}${diff.toFixed(1)}${unit}`;
  el2.style.color = diff > 0 ? '#d97706' : '#3b82f6';
}


/* ──────────────────────────────────────────────────────────────────
   9. GRAPHIQUE PRINCIPAL (Chart.js) — Temp + Humidité
────────────────────────────────────────────────────────────────── */
let mainChart = null;

function initMainChart() {
  const ctx = el('envChart');
  if (!ctx) return;

  const shared = {
    tension: 0.45, pointRadius: 0, pointHoverRadius: 5,
    borderWidth: 2.5, fill: true, spanGaps: true
  };

  mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          ...shared,
          label: 'Température (°C)',
          data: [],
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.06)',
          yAxisID: 'yT'
        },
        {
          ...shared,
          label: 'Humidité (%)',
          data: [],
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.06)',
          yAxisID: 'yH'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: {
        duration: 300,
        easing: 'easeOutCubic'
      },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a2332',
          borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
          titleColor: '#94a3b8', bodyColor: '#e2e8f0',
          padding: 12, cornerRadius: 8,
          callbacks: {
            label: c => `  ${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? '–'}`
          }
        }
      },
      scales: {
        x: {
          grid:  { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 8 }
        },
        yT: {
          type: 'linear', position: 'left',
          grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
          ticks: { color: '#ef4444', font: { size: 10 }, callback: v => v + '°' }
        },
        yH: {
          type: 'linear', position: 'right',
          grid: { display: false },
          ticks: { color: '#3b82f6', font: { size: 10 }, callback: v => v + '%' },
          min: 0, max: 100
        }
      }
    }
  });
}

function updateMainChart() {
  if (!mainChart) return;
  const { temperature, humidity } = STATE.sensors;
  if (temperature === null && humidity === null) return;

  const label = STATE.sensors.lastUpdate.toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  if (STATE.chart.labels.length >= CONFIG.chart.maxPoints) {
    STATE.chart.labels.shift();
    STATE.chart.tempData.shift();
    STATE.chart.humData.shift();
  }
  STATE.chart.labels.push(label);
  STATE.chart.tempData.push(temperature ?? null);
  STATE.chart.humData.push(humidity    ?? null);

  mainChart.data.labels           = STATE.chart.labels;
  mainChart.data.datasets[0].data = STATE.chart.tempData;
  mainChart.data.datasets[1].data = STATE.chart.humData;
  mainChart.update();

  const emptyEl = el('chart-empty');
  if (emptyEl) emptyEl.classList.add('hidden');
}


/* ──────────────────────────────────────────────────────────────────
   10. SPARKLINES (mini-graphiques par carte)
────────────────────────────────────────────────────────────────── */
const sparkCharts = {};

const SPARK_CONFIGS = {
  temp: { canvas: 'spark-temp', color: '#ef4444', bg: 'rgba(239,68,68,0.08)' },
  hum:  { canvas: 'spark-hum',  color: '#3b82f6', bg: 'rgba(59,130,246,0.08)' },
  lux:  { canvas: 'spark-lux',  color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' }
};

function initSparklines() {
  Object.entries(SPARK_CONFIGS).forEach(([key, cfg]) => {
    const ctx = el(cfg.canvas);
    if (!ctx) return;

    sparkCharts[key] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: cfg.color,
          backgroundColor: cfg.bg,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.4,
          spanGaps: true
        }]
      },
      options: {
        responsive: false,
        animation: { duration: 250 },
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false }
        },
        elements: { line: { borderCapStyle: 'round' } }
      }
    });
  });
}

function pushSparkData(key, value) {
  if (!STATE.sparks[key]) return;
  STATE.sparks[key].push(value);
  if (STATE.sparks[key].length > CONFIG.spark.maxPoints) STATE.sparks[key].shift();
}

function updateSparklines() {
  Object.keys(SPARK_CONFIGS).forEach(key => {
    const sc = sparkCharts[key];
    if (!sc) return;
    const data   = STATE.sparks[key];
    const labels = data.map((_, i) => i);
    sc.data.labels           = labels;
    sc.data.datasets[0].data = data;
    sc.update('none');
  });
}


/* ──────────────────────────────────────────────────────────────────
   11. JOURNAL D'ÉVÉNEMENTS
────────────────────────────────────────────────────────────────── */

/**
 * Journalise les mises à jour significatives et les franchissements de seuils.
 */
function logUpdate() {
  const { temperature, humidity, iaq } = STATE.sensors;
  const { prevSensors }                = STATE;
  const thr                            = CONFIG.thresholds;

  // Franchissement seuil température
  if (temperature !== null && (prevSensors.temperature || 0) < thr.temp.danger && temperature >= thr.temp.danger) {
    addLogItem(`⚠ Température critique : ${temperature.toFixed(1)} °C`, 'danger');
  } else if (temperature !== null && (prevSensors.temperature || 0) < thr.temp.warn && temperature >= thr.temp.warn) {
    addLogItem(`⚡ Température élevée : ${temperature.toFixed(1)} °C`, 'warn');
  }

  // Franchissement seuil humidité
  if (humidity !== null && (prevSensors.humidity || 0) < thr.hum.danger && humidity >= thr.hum.danger) {
    addLogItem(`⚠ Humidité critique : ${humidity.toFixed(1)} %`, 'danger');
  }

  // Franchissement seuil IAQ
  if (iaq !== null && (prevSensors.iaq || 0) < thr.iaq.danger && iaq >= thr.iaq.danger) {
    addLogItem(`⚠ Qualité de l'air dégradée : IAQ ${iaq.toFixed(0)}`, 'danger');
  }

  // Log de mise à jour normale (toutes les N mesures)
  if (STATE.log.length === 0 || true) {
    const parts = [];
    if (temperature !== null) parts.push(`T: ${temperature.toFixed(1)}°C`);
    if (humidity    !== null) parts.push(`H: ${humidity.toFixed(1)}%`);
    if (iaq         !== null) parts.push(`IAQ: ${iaq.toFixed(0)}`);
    if (parts.length > 0) addLogItem(`Mesure reçue — ${parts.join(' · ')}`, 'ok');
  }
}

function addLogItem(message, type = 'ok') {
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  STATE.log.unshift({ time, message, type });
  if (STATE.log.length > CONFIG.history.maxItems) STATE.log.pop();

  const panel   = el('log-panel');
  const emptyEl = el('log-empty');
  if (!panel) return;

  const div = document.createElement('div');
  div.className = `log-item log-item--${type}`;
  div.innerHTML = `
    <span class="log-time">${escapeHtml(time)}</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;

  panel.insertBefore(div, emptyEl ? emptyEl.nextSibling : panel.firstChild);
  if (emptyEl) emptyEl.style.display = 'none';
}


/* ──────────────────────────────────────────────────────────────────
   12. MODE DÉMO (données simulées si Firebase non disponible)
────────────────────────────────────────────────────────────────── */
let demoTick = 0;
let demoInterval = null;

function startDemoMode() {
  if (demoInterval) return; // Déjà actif

  addLogItem('[Démo] Firebase non disponible — données simulées actives', 'warn');
  showToast('Mode démonstration — données simulées', 'info');

  // Première génération immédiate
  generateDemoData();

  demoInterval = setInterval(() => {
    generateDemoData();
    demoTick++;
  }, CONFIG.demo.interval);
}

function generateDemoData() {
  const t = demoTick;
  const temp = 26 + Math.sin(t * 0.25) * 6   + (Math.random() - 0.5) * 1.2;
  const hum  = 55 + Math.sin(t * 0.18) * 12  + (Math.random() - 0.5) * 1.5;
  const pres = 1013 + Math.sin(t * 0.07) * 8 + (Math.random() - 0.5) * 0.5;
  const lux  = Math.max(10, 400 + Math.sin(t * 0.12) * 300 + (Math.random() - 0.5) * 40);
  const iaq  = Math.max(10, 70 + Math.sin(t * 0.2) * 50  + (Math.random() - 0.5) * 10);
  const co2  = Math.max(400, 750 + Math.sin(t * 0.15) * 200 + (Math.random() - 0.5) * 30);

  onNewData({
    temp:     parseFloat(temp.toFixed(1)),
    hum:      parseFloat(hum.toFixed(1)),
    pression: parseFloat(pres.toFixed(1)),   // Clé "pression" conforme au firmware
    lux:      parseFloat(lux.toFixed(0)),
    iaq:      parseFloat(iaq.toFixed(1)),
    co2:      parseFloat(co2.toFixed(0))
  });
}


/* ──────────────────────────────────────────────────────────────────
   13. TOAST & UTILITAIRES
────────────────────────────────────────────────────────────────── */

function showToast(message, type = 'ok', duration = 3500) {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast ${type} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function startClock() {
  const clockEl = el('clock');
  if (!clockEl) return;
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };
  tick();
  setInterval(tick, 1000);

  const yearEl = el('footer-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

// Raccourci getElementById
const el = id => document.getElementById(id);


/* ──────────────────────────────────────────────────────────────────
   14. LISTENERS INTERFACE
────────────────────────────────────────────────────────────────── */

function attachListeners() {
  // Effacer le journal
  el('btn-clear-log')?.addEventListener('click', () => {
    STATE.log = [];
    const panel   = el('log-panel');
    const emptyEl = el('log-empty');
    if (!panel) return;
    Array.from(panel.querySelectorAll('.log-item')).forEach(e => e.remove());
    if (emptyEl) emptyEl.style.display = '';
    showToast('Journal effacé', 'info', 2000);
  });
}


/* ──────────────────────────────────────────────────────────────────
   15. BOOTSTRAP — Point d'entrée
────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  startClock();
  initMainChart();
  initSparklines();
  attachListeners();
  initFirebase();

  // Log initial
  addLogItem('SmartHome Sentinel V2.0 initialisé — Raven Lab × Moov Africa', 'ok');

  console.log('[Sentinel V2] Initialisation — SIL/telemetrie en écoute');
});
