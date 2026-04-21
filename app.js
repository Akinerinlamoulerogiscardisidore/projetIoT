/**
 * ══════════════════════════════════════════════════════════════════
 *  SmartHome Sentinel · app.js
 *  Propulsé par Moov Africa 5G · Firebase RTDB
 * ══════════════════════════════════════════════════════════════════
 *
 *  STRUCTURE FIREBASE (v11 — SmartHome)
 *  ──────────────────────────────────────
 *  LECTURE (Télémétrie)
 *    SIL/telemetrie → { temp, hum, lux, pression, iaq, co2, iaqAcc }
 *
 *  ÉCRITURE (Commandes)
 *    SIL/commandes  → { light1, light2, fan, lock }
 *
 *  MODE
 *    SIL/mode_auto → boolean
 *
 *  PATTERN "OPTIMISTIC UI"
 *  ──────────────────────────────────────
 *  Chaque clic sur un bouton met à jour STATE et le DOM
 *  INSTANTANÉMENT, avant que Firebase ne confirme.
 *  En cas d'erreur Firebase → rollback visuel avec toast d'erreur.
 *  Résultat perçu : latence ZÉRO même sur réseau lent.
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

// ── Chemins Firebase (NE PAS MODIFIER — correspondance stricte firmware)
const DB = {
  telemetry: 'SIL/telemetrie',   // Clés : temp, hum, lux, pression, iaq, co2, iaqAcc
  commands:  'SIL/commandes',    // Clés : light1, light2, fan, lock
  mode:      'SIL/mode_auto'
};


/* ──────────────────────────────────────────────────────────────────
   2. CONFIGURATION SYSTÈME
────────────────────────────────────────────────────────────────── */
const CONFIG = {
  temp:  { warn: 28,   danger: 35   },
  hum:   { warn: 65,   danger: 80   },
  iaq:   { warn: 100,  danger: 200  },
  co2:   { warn: 1000, danger: 2000 },
  auto:  { fanOn: 30.0, fanOff: 28.5 },
  chart: { maxPoints: 30, demoInterval: 5000 },
  history: { maxItems: 60 },
  demo:    { enabled: true }
};


/* ──────────────────────────────────────────────────────────────────
   3. ÉTAT CENTRALISÉ
────────────────────────────────────────────────────────────────── */
const STATE = {
  firebase:  { connected: false, db: null },
  connectTime: null,   // Pour calcul latence badge 5G

  sensors: {
    temperature: null,
    humidity:    null,
    light:       null,
    pressure:    null,
    iaq:         null,
    co2:         null,
    iaqAcc:      null,   // Précision IAQ (0-3)
    lastUpdate:  null
  },

  // Actionneurs : 4 commandes SmartHome
  actuators: {
    light1: null,   // Lampe Chambre 1
    light2: null,   // Lampe Chambre 2
    fan:    null,   // Ventilateur
    lock:   null    // Serrure électromagnétique
  },

  isAutoMode:  null,
  alerts:      [],
  history:     [],
  prevSensors: {},
  chart: { labels: [], tempData: [], humData: [] }
};


/* ──────────────────────────────────────────────────────────────────
   4. FIREBASE — Initialisation & Listeners
────────────────────────────────────────────────────────────────── */

function initFirebase() {
  const configured = FIREBASE_CONFIG.apiKey !== 'VOTRE_API_KEY';

  if (configured) {
    try {
      const app = firebase.initializeApp(FIREBASE_CONFIG);
      STATE.firebase.db = firebase.database(app);
      attachListeners();
    } catch (err) {
      console.error('[Sentinel] Firebase init error:', err);
      setFirebaseStatus(false);
      if (CONFIG.demo.enabled) startDemoMode();
    }
  } else {
    console.warn('[Sentinel] Firebase non configuré → Mode démo');
    setFirebaseStatus(false, 'Démo');
    if (CONFIG.demo.enabled) startDemoMode();
  }
}

function attachListeners() {
  const db = STATE.firebase.db;

  // Connexion
  firebase.database().ref('.info/connected').on('value', snap => {
    const ok = snap.val() === true;
    STATE.firebase.connected = ok;
    if (ok) STATE.connectTime = Date.now();
    setFirebaseStatus(ok);
    updateLatencyBadge(ok);
  });

  // Télémétrie → déclenchement logique AUTO + rendu
  db.ref(DB.telemetry).on('value', snap => {
    const t0 = performance.now();
    const data = snap.val();
    if (data) {
      onSensorData(data);
      updateLatencyFromRTT(performance.now() - t0);
    }
  }, err => console.error('[Sentinel] telemetrie:', err));

  // Commandes → miroir local (pour sync après clic d'un autre client)
  db.ref(DB.commands).on('value', snap => {
    const data = snap.val();
    if (data) onActuatorData(data);
  }, err => console.error('[Sentinel] commandes:', err));

  // Mode
  db.ref(DB.mode).on('value', snap => {
    if (snap.val() !== null) applyMode(Boolean(snap.val()));
  }, err => console.error('[Sentinel] mode_auto:', err));
}


/* ──────────────────────────────────────────────────────────────────
   5. TRAITEMENT TÉLÉMÉTRIE
────────────────────────────────────────────────────────────────── */

function onSensorData(data) {
  const prev = { ...STATE.sensors };

  // Mapping Firebase → STATE (clé "pression" dans Firebase)
  STATE.sensors.temperature = data.temp      !== undefined ? parseFloat(data.temp)     : null;
  STATE.sensors.humidity    = data.hum       !== undefined ? parseFloat(data.hum)      : null;
  STATE.sensors.light       = data.lux       !== undefined ? parseFloat(data.lux)      : null;
  STATE.sensors.pressure    = data.pression  !== undefined ? parseFloat(data.pression) : null;
  STATE.sensors.iaq         = data.iaq       !== undefined ? parseFloat(data.iaq)      : null;
  STATE.sensors.co2         = data.co2       !== undefined ? parseFloat(data.co2)      : null;
  STATE.sensors.iaqAcc      = data.iaqAcc    !== undefined ? parseFloat(data.iaqAcc)   : null;
  STATE.sensors.lastUpdate  = new Date();

  renderSensorCards();
  checkAlerts(prev);
  updateChart();
  updateGlobalStatus();
  updateTimestamp();
  runAutoLogic();
}


/* ──────────────────────────────────────────────────────────────────
   LOGIQUE AUTO (côté Dashboard)
   Seul le ventilateur est piloté automatiquement (seuil thermique).
────────────────────────────────────────────────────────────────── */
function runAutoLogic() {
  if (STATE.isAutoMode !== true) return;
  const db   = STATE.firebase.db;
  const temp = STATE.sensors.temperature;
  if (!db || temp === null) return;

  if (temp > CONFIG.auto.fanOn && STATE.actuators.fan !== true) {
    db.ref(`${DB.commands}/fan`).set(true).then(() => {
      addHistoryItem(`AUTO — Ventilateur activé (${temp.toFixed(1)} °C)`, 'fan');
      showToast('Ventilateur activé automatiquement', 'info');
    });
  } else if (temp < CONFIG.auto.fanOff && STATE.actuators.fan !== false) {
    db.ref(`${DB.commands}/fan`).set(false).then(() => {
      addHistoryItem(`AUTO — Ventilateur arrêté (${temp.toFixed(1)} °C)`, 'fan');
    });
  }
}


/* ──────────────────────────────────────────────────────────────────
   6. TRAITEMENT COMMANDES (miroir depuis Firebase)
────────────────────────────────────────────────────────────────── */

function onActuatorData(data) {
  const prev = { ...STATE.actuators };

  STATE.actuators.light1 = data.light1 !== undefined ? Boolean(data.light1) : null;
  STATE.actuators.light2 = data.light2 !== undefined ? Boolean(data.light2) : null;
  STATE.actuators.fan    = data.fan    !== undefined ? Boolean(data.fan)    : null;
  STATE.actuators.lock   = data.lock   !== undefined ? Boolean(data.lock)   : null;

  // Rendu (ne remplace pas l'état optimiste si déjà à jour)
  renderAllDevices();

  // Historique des changements (ignorer premier remplissage null→val)
  const changes = [
    ['light1', 'Lampe Chambre 1'],
    ['light2', 'Lampe Chambre 2'],
    ['fan',    'Ventilateur'],
    ['lock',   'Serrure']
  ];
  changes.forEach(([key, label]) => {
    if (prev[key] !== null && prev[key] !== STATE.actuators[key]) {
      const s = STATE.actuators[key] ? 'activé(e)' : 'désactivé(e)';
      addHistoryItem(`${label} ${s}`, key === 'lock' ? 'security' : 'relay');
    }
  });

  updateGlobalStatus();
}


/* ──────────────────────────────────────────────────────────────────
   7. OPTIMISTIC UI — POINT D'ENTRÉE PRINCIPAL DES CLICS
────────────────────────────────────────────────────────────────── */

/**
 * toggleDevice — appelé directement depuis onclick HTML
 * Applique l'OPTIMISTIC UPDATE immédiatement sur le DOM,
 * puis envoie la commande à Firebase.
 * En cas d'erreur : rollback visuel.
 */
function toggleDevice(key) {
  // Guard : mode AUTO (seul le verrou reste toujours accessible)
  if (STATE.isAutoMode === true && key !== 'lock') {
    showToast('Mode AUTO actif — passez en Manuel', 'warn');
    return;
  }

  const currentState  = STATE.actuators[key];
  const desiredState  = currentState === null ? true : !currentState;

  // ── OPTIMISTIC UPDATE (instantané, AVANT Firebase) ──────────────
  STATE.actuators[key] = desiredState;
  renderDevice(key);
  showToast(`${labelOf(key)} → ${desiredState ? 'ON' : 'OFF'}`, 'optimistic');
  addHistoryItem(`⚡ ${labelOf(key)} → ${desiredState ? 'ON' : 'OFF'} (en cours…)`, 'relay');

  // ── Confirmation lock (sécurité) ─────────────────────────────────
  if (key === 'lock') {
    const action = desiredState ? 'OUVRIR' : 'FERMER';
    if (!confirm(`⚠ Sécurité — Confirmer : ${action} la serrure électromagnétique ?`)) {
      // Annulation : rollback
      STATE.actuators[key] = currentState;
      renderDevice(key);
      return;
    }
  }

  const db = STATE.firebase.db;
  if (!db) {
    // Mode démo : l'état optimiste est conservé
    const lastItem = document.querySelector('#history-panel .history-item');
    if (lastItem) {
      lastItem.querySelector('.history-msg').textContent =
        `[Démo] ${labelOf(key)} → ${desiredState ? 'ON' : 'OFF'}`;
    }
    return;
  }

  // ── Écriture Firebase (asynchrone) ───────────────────────────────
  db.ref(`${DB.commands}/${key}`).set(desiredState)
    .then(() => {
      // Succès confirmé — mettre à jour le dernier item d'historique
      addHistoryItem(`✓ ${labelOf(key)} confirmé → ${desiredState ? 'ON' : 'OFF'}`, 'relay');
    })
    .catch(err => {
      console.error('[Sentinel] Erreur commande:', err);
      // ── ROLLBACK : Firebase a refusé → retour à l'état précédent
      STATE.actuators[key] = currentState;
      renderDevice(key);
      showToast(`Erreur Firebase — rollback ${labelOf(key)}`, 'danger');
      addHistoryItem(`✗ Échec ${labelOf(key)} — retour état précédent`, 'error');
    });
}


/* ──────────────────────────────────────────────────────────────────
   8. RENDU — Cartes capteurs
────────────────────────────────────────────────────────────────── */

function renderSensorCards() {
  const { temperature, humidity, light, pressure, iaq, co2, iaqAcc } = STATE.sensors;

  renderSensorCard({
    cardId: 'card-temp', valueId: 'temp-value', trendId: 'temp-trend',
    value: temperature, unit: '°C',
    warnAt: CONFIG.temp.warn, dangerAt: CONFIG.temp.danger,
    prev: STATE.prevSensors.temperature
  });

  renderSensorCard({
    cardId: 'card-hum', valueId: 'hum-value', trendId: 'hum-trend',
    value: humidity, unit: '%',
    warnAt: CONFIG.hum.warn, dangerAt: CONFIG.hum.danger,
    prev: STATE.prevSensors.humidity
  });

  renderSensorCard({
    cardId: 'card-lux', valueId: 'lux-value', trendId: 'lux-trend',
    value: light, unit: ' lx', warnAt: null, dangerAt: null,
    prev: STATE.prevSensors.light
  });

  renderSensorCard({
    cardId: 'card-pres', valueId: 'pres-value', trendId: 'pres-trend',
    value: pressure, unit: ' hPa', warnAt: null, dangerAt: null,
    prev: STATE.prevSensors.pressure, decimals: 1
  });

  renderIAQCard(iaq, co2, iaqAcc);

  STATE.prevSensors = { temperature, humidity, light, pressure, iaq, co2, iaqAcc };
}

function renderSensorCard({ cardId, valueId, trendId, value, unit, warnAt, dangerAt, prev, decimals = 1 }) {
  const card    = el(cardId);
  const valueEl = el(valueId);
  const trendEl = el(trendId);
  if (!card || !valueEl) return;

  if (value === null || value === undefined || isNaN(value)) {
    valueEl.textContent = '– –';
    card.className = card.className.replace(/\bstate-\w+\b/g, '').trim();
    return;
  }

  const fmt = Number.isInteger(value) ? String(value) : value.toFixed(decimals);
  valueEl.textContent = fmt + unit;
  valueEl.classList.remove('val-flash');
  void valueEl.offsetWidth;
  valueEl.classList.add('val-flash');

  // État
  const base = [...card.classList].filter(c => !c.startsWith('state-')).join(' ');
  if (dangerAt !== null && value >= dangerAt)      card.className = base + ' state-danger';
  else if (warnAt !== null && value >= warnAt)     card.className = base + ' state-warn';
  else                                              card.className = base + ' state-ok';

  // Tendance
  if (trendEl && prev !== null && prev !== undefined) {
    const diff = value - prev;
    if (Math.abs(diff) > 0.05) {
      trendEl.textContent = `${diff > 0 ? '↑' : '↓'} ${diff > 0 ? '+' : ''}${diff.toFixed(1)}${unit}`;
      trendEl.style.color = diff > 0 ? 'var(--amber)' : 'var(--cyan)';
    }
  }
}

function renderIAQCard(iaq, co2, iaqAcc) {
  const card    = el('card-iaq');
  const iaqEl   = el('iaq-value');
  const co2El   = el('co2-value');
  const accEl   = el('iaq-acc-value');
  const badge   = el('iaq-badge');
  const pointer = el('iaq-pointer');
  if (!card || !iaqEl) return;

  if (iaq === null || isNaN(iaq)) {
    iaqEl.textContent = '–';
    card.className = card.className.replace(/\bstate-\w+\b/g, '').trim();
    if (badge) badge.textContent = '–';
  } else {
    iaqEl.textContent = iaq.toFixed(0);
    iaqEl.classList.remove('val-flash');
    void iaqEl.offsetWidth;
    iaqEl.classList.add('val-flash');

    let cls, label, badgeCls;
    if      (iaq <= 50)  { cls = 'state-ok';     label = 'EXCELLENT'; badgeCls = 'iaq-quality-badge iaq-excellent'; }
    else if (iaq <= 100) { cls = 'state-ok';     label = 'BON';       badgeCls = 'iaq-quality-badge iaq-good'; }
    else if (iaq <= 150) { cls = 'state-warn';   label = 'MODÉRÉ';    badgeCls = 'iaq-quality-badge iaq-moderate'; }
    else if (iaq <= 200) { cls = 'state-warn';   label = 'DÉGRADÉ';   badgeCls = 'iaq-quality-badge iaq-moderate'; }
    else                 { cls = 'state-danger'; label = 'MAUVAIS';   badgeCls = 'iaq-quality-badge iaq-poor'; }

    const base = [...card.classList].filter(c => !c.startsWith('state-')).join(' ');
    card.className = base + ' ' + cls;
    if (badge) { badge.textContent = label; badge.className = badgeCls; }

    // Aiguille sur la barre IAQ (0-500 → 0-100%)
    if (pointer) pointer.style.left = Math.min(99, iaq / 500 * 100) + '%';
  }

  // CO₂
  if (co2El) {
    co2El.textContent = co2 !== null && !isNaN(co2) ? co2.toFixed(0) : '–';
    co2El.style.color = co2 !== null && co2 > CONFIG.co2.danger ? 'var(--red)'
                       : co2 !== null && co2 > CONFIG.co2.warn  ? 'var(--amber)'
                       : 'var(--text-2)';
  }

  // Précision IAQ (0=non calibré, 1=basse, 2=moy, 3=haute)
  if (accEl) {
    const accLabels = ['Non calibré', 'Basse', 'Moyenne', 'Haute'];
    const accColors = ['var(--text-3)', 'var(--amber)', 'var(--cyan)', 'var(--emerald)'];
    const a = iaqAcc !== null ? Math.round(iaqAcc) : null;
    accEl.textContent = a !== null ? (accLabels[a] || a) : '–';
    accEl.style.color = a !== null ? (accColors[a] || 'var(--text-2)') : 'var(--text-3)';
  }
}


/* ──────────────────────────────────────────────────────────────────
   9. RENDU — Appareils (power buttons + serrure)
────────────────────────────────────────────────────────────────── */

function renderAllDevices() {
  renderDevice('light1');
  renderDevice('light2');
  renderDevice('fan');
  renderDevice('lock');
}

/**
 * Rendu d'un appareil spécifique.
 * Appelé aussi bien par l'optimistic update que par onActuatorData.
 */
function renderDevice(key) {
  const value = STATE.actuators[key];

  if (key === 'lock') {
    renderLock(value);
    return;
  }

  const btn       = el(`btn-${key}`);
  const statusEl  = el(`${key}-status`);
  if (!btn) return;

  if (value === null) {
    btn.setAttribute('data-active', 'false');
    if (statusEl) statusEl.textContent = '–';
    return;
  }

  btn.setAttribute('data-active', value ? 'true' : 'false');
  if (statusEl) statusEl.textContent = value ? 'ON' : 'OFF';
}

function renderLock(value) {
  const panel   = el('lock-panel');
  const stateEl = el('lock-state-label');
  const btnEl   = el('btn-lock');
  const btnText = el('lock-btn-text');
  if (!panel) return;

  if (value === null) {
    panel.setAttribute('data-locked', 'true');
    if (stateEl) stateEl.textContent = 'État inconnu';
    return;
  }

  // data-locked="true" = serrure fermée (verrou actif)
  // data-locked="false" = serrure ouverte (verrou désactivé)
  panel.setAttribute('data-locked', value ? 'true' : 'false');
  if (stateEl) stateEl.textContent = value ? '● VERROUILLÉ' : '○ OUVERT';
  if (btnEl)   btnEl.setAttribute('data-active', value ? 'true' : 'false');
  if (btnText) btnText.textContent = value ? 'DÉVERROUILLER' : 'VERROUILLER';
}


/* ──────────────────────────────────────────────────────────────────
   10. GESTION DU MODE
────────────────────────────────────────────────────────────────── */

function applyMode(isAuto) {
  if (STATE.isAutoMode === isAuto) return;
  const wasNull = STATE.isAutoMode === null;
  STATE.isAutoMode = isAuto;

  const btnAuto   = el('btn-mode-auto');
  const btnManual = el('btn-mode-manual');
  if (btnAuto) {
    btnAuto.classList.toggle('mode-btn--active', isAuto);
    btnAuto.setAttribute('aria-pressed', String(isAuto));
  }
  if (btnManual) {
    btnManual.classList.toggle('mode-btn--active', !isAuto);
    btnManual.setAttribute('aria-pressed', String(!isAuto));
  }

  const descEl = el('mode-desc');
  if (descEl) {
    descEl.textContent = isAuto
      ? 'Régulation intelligente active — le système pilote automatiquement les équipements de confort selon les conditions ambiantes détectées.'
      : 'Mode Manuel — Vous contrôlez directement les équipements via les boutons ci-dessous.';
  }

  // Overlay sur les commandes de confort (pas la serrure)
  const overlay     = el('auto-lock-overlay');
  const lockOverlay = el('lock-auto-overlay');
  if (overlay)     overlay.classList.toggle('visible', isAuto);
  if (lockOverlay) lockOverlay.classList.toggle('visible', isAuto);

  // Activer/désactiver les boutons d'appareils
  ['light1','light2','fan'].forEach(key => {
    const btn = el(`btn-${key}`);
    if (btn) btn.disabled = isAuto;
  });
  const lockBtn = el('btn-lock');
  if (lockBtn) lockBtn.disabled = isAuto;

  if (!wasNull) {
    addHistoryItem(`Mode → ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info');
    showToast(`Mode ${isAuto ? 'AUTO activé' : 'MANUEL activé'}`, isAuto ? 'info' : 'ok');
  }
}

function sendModeCommand(isAuto) {
  const db = STATE.firebase.db;
  if (!db) {
    STATE.isAutoMode = null;
    applyMode(isAuto);
    addHistoryItem(`[Démo] Mode → ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info');
    return;
  }
  db.ref(DB.mode).set(isAuto)
    .then(() => addHistoryItem(`Dashboard → Mode ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info'))
    .catch(err => { console.error(err); showToast('Erreur mode', 'danger'); });
}


/* ──────────────────────────────────────────────────────────────────
   11. GRAPHIQUE (Chart.js)
────────────────────────────────────────────────────────────────── */
let chart = null;

function initChart() {
  const ctx = el('envChart');
  if (!ctx) return;

  const shared = { tension: 0.4, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2, fill: true, spanGaps: true };

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { ...shared, label: 'Température (°C)', data: [], borderColor: '#ff6b6b', backgroundColor: 'rgba(255,107,107,0.06)', yAxisID: 'yT' },
        { ...shared, label: 'Humidité (%)',      data: [], borderColor: '#00f5ff', backgroundColor: 'rgba(0,245,255,0.06)',   yAxisID: 'yH' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(8,20,42,0.95)',
          borderColor: 'rgba(0,245,255,0.2)', borderWidth: 1,
          titleColor: '#d4eeff', bodyColor: '#6a96b8',
          padding: 12, cornerRadius: 6,
          callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? 'N/A'}` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(0,245,255,0.04)' }, ticks: { color: '#2a4a6a', font: { size: 9, family: 'JetBrains Mono' }, maxTicksLimit: 8 } },
        yT: { type: 'linear', position: 'left',  grid: { color: 'rgba(0,245,255,0.04)' }, ticks: { color: '#ff6b6b', font: { size: 9 }, callback: v => v + '°' } },
        yH: { type: 'linear', position: 'right', grid: { display: false }, ticks: { color: '#00f5ff', font: { size: 9 }, callback: v => v + '%' }, min: 0, max: 100 }
      }
    }
  });
}

function updateChart() {
  if (!chart) return;
  const { temperature, humidity } = STATE.sensors;
  if (temperature === null && humidity === null) return;

  const label = (STATE.sensors.lastUpdate || new Date())
    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (STATE.chart.labels.length >= CONFIG.chart.maxPoints) {
    STATE.chart.labels.shift(); STATE.chart.tempData.shift(); STATE.chart.humData.shift();
  }
  STATE.chart.labels.push(label);
  STATE.chart.tempData.push(temperature ?? null);
  STATE.chart.humData.push(humidity    ?? null);

  chart.data.labels           = STATE.chart.labels;
  chart.data.datasets[0].data = STATE.chart.tempData;
  chart.data.datasets[1].data = STATE.chart.humData;
  chart.update('none');

  const empty = el('chart-empty');
  if (empty) empty.classList.add('hidden');
}


/* ──────────────────────────────────────────────────────────────────
   12. ALERTES
────────────────────────────────────────────────────────────────── */

function checkAlerts(prev) {
  const { temperature, humidity, iaq, co2 } = STATE.sensors;
  const alerts = [];

  if (temperature !== null) {
    if (temperature >= CONFIG.temp.danger)    alerts.push({ type: 'danger', msg: `🌡 Température critique : ${temperature.toFixed(1)} °C` });
    else if (temperature >= CONFIG.temp.warn) alerts.push({ type: 'warn',   msg: `🌡 Température élevée : ${temperature.toFixed(1)} °C` });
  }
  if (humidity !== null) {
    if (humidity >= CONFIG.hum.danger)    alerts.push({ type: 'danger', msg: `💧 Humidité critique : ${humidity.toFixed(1)} %` });
    else if (humidity >= CONFIG.hum.warn) alerts.push({ type: 'warn',   msg: `💧 Humidité élevée : ${humidity.toFixed(1)} %` });
  }
  if (iaq !== null) {
    if (iaq >= CONFIG.iaq.danger)    alerts.push({ type: 'danger', msg: `☁ Qualité d'air très dégradée : IAQ ${iaq.toFixed(0)}` });
    else if (iaq >= CONFIG.iaq.warn) alerts.push({ type: 'warn',   msg: `☁ Qualité d'air modérée : IAQ ${iaq.toFixed(0)}` });
  }
  if (co2 !== null) {
    if (co2 >= CONFIG.co2.danger)    alerts.push({ type: 'danger', msg: `⚠ CO₂ dangereux : ${co2.toFixed(0)} ppm` });
    else if (co2 >= CONFIG.co2.warn) alerts.push({ type: 'warn',   msg: `⚠ CO₂ élevé : ${co2.toFixed(0)} ppm` });
  }

  if (temperature !== null && (prev.temperature || 0) < CONFIG.temp.danger && temperature >= CONFIG.temp.danger) {
    addHistoryItem(`⚠ Seuil critique Température : ${temperature.toFixed(1)} °C`, 'temp');
  }

  STATE.alerts = alerts;
  renderAlerts();
  updateGlobalStatus();
}

function renderAlerts() {
  const panel = el('alerts-panel');
  const empty = el('alerts-empty');
  const badge = el('alert-count');
  if (!panel) return;

  Array.from(panel.querySelectorAll('.alert-item')).forEach(e => e.remove());

  if (STATE.alerts.length === 0) {
    if (empty) empty.style.display = '';
    if (badge) { badge.classList.remove('visible'); badge.textContent = ''; }
    return;
  }

  if (empty) empty.style.display = 'none';
  if (badge) { badge.textContent = STATE.alerts.length; badge.classList.add('visible'); }

  const iconW = `<svg style="width:14px;height:14px;flex-shrink:0;margin-top:1px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const iconD = `<svg style="width:14px;height:14px;flex-shrink:0;margin-top:1px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  STATE.alerts.forEach(a => {
    const d = document.createElement('div');
    d.className = `alert-item alert-item--${a.type}`;
    d.innerHTML = (a.type === 'danger' ? iconD : iconW) + `<span>${escapeHtml(a.msg)}</span>`;
    panel.appendChild(d);
  });
}

function updateGlobalStatus() {
  const badge = el('global-status');
  const label = el('global-status-label');
  if (!badge || !label) return;

  const dangers = STATE.alerts.filter(a => a.type === 'danger').length;
  const warns   = STATE.alerts.filter(a => a.type === 'warn').length;

  badge.className = 'status-pill status-pill--alert';
  if (dangers > 0)                             { badge.classList.add('danger'); label.textContent = 'CRITIQUE'; }
  else if (warns > 0)                          { badge.classList.add('warn');   label.textContent = 'ALERTE'; }
  else if (STATE.sensors.temperature !== null) { badge.classList.add('ok');    label.textContent = 'NOMINAL'; }
  else                                         { label.textContent = 'INIT'; }
}


/* ──────────────────────────────────────────────────────────────────
   13. HISTORIQUE
────────────────────────────────────────────────────────────────── */

function addHistoryItem(message, type = 'info') {
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  STATE.history.unshift({ time, message, type });
  if (STATE.history.length > CONFIG.history.maxItems) STATE.history.pop();

  const panel   = el('history-panel');
  const emptyEl = el('history-empty');
  if (!panel) return;

  const d = document.createElement('div');
  d.className = 'history-item';
  d.innerHTML = `<span class="history-time">${escapeHtml(time)}</span><span class="history-msg">${escapeHtml(message)}</span>`;
  panel.insertBefore(d, emptyEl ? emptyEl.nextSibling : panel.firstChild);
  if (emptyEl) emptyEl.style.display = 'none';
}


/* ──────────────────────────────────────────────────────────────────
   14. BADGE 5G — Latence
────────────────────────────────────────────────────────────────── */

function updateLatencyBadge(connected) {
  const badgeEl = el('badge-5g');
  const latEl   = el('badge-latency');
  if (!badgeEl) return;

  if (!connected) {
    badgeEl.style.opacity = '0.4';
    if (latEl) latEl.textContent = 'OFFLINE';
  } else {
    badgeEl.style.opacity = '1';
  }
}

function updateLatencyFromRTT(rttMs) {
  const latEl = el('badge-latency');
  if (!latEl) return;
  // Arrondir à l'unité, afficher en ms
  const ms = Math.round(rttMs);
  latEl.textContent = `${ms}ms`;
}


/* ──────────────────────────────────────────────────────────────────
   15. UTILITAIRES
────────────────────────────────────────────────────────────────── */

const el = id => document.getElementById(id);

function setFirebaseStatus(connected, customLabel = null) {
  const badge = el('firebase-status');
  const label = el('firebase-label');
  if (!badge || !label) return;
  badge.classList.remove('connected', 'disconnected');
  badge.classList.add(connected ? 'connected' : 'disconnected');
  label.textContent = customLabel ?? (connected ? 'Firebase OK' : 'Déconnecté');
}

function showToast(message, type = 'ok', duration = 3000) {
  const toast = el('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast ${type} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function setFeedback(feedEl, msg, cls) {
  if (!feedEl) return;
  feedEl.textContent = msg;
  feedEl.className   = 'cmd-feedback glass-panel' + (cls ? ` ${cls}` : '');
  feedEl.classList.add('visible');
  clearTimeout(feedEl._t);
  feedEl._t = setTimeout(() => feedEl.classList.remove('visible'), 3500);
}

function updateTimestamp() {
  const t = el('last-update-time');
  if (!t || !STATE.sensors.lastUpdate) return;
  t.textContent = STATE.sensors.lastUpdate.toLocaleTimeString('fr-FR');
}

function startClock() {
  const clockEl = el('clock');
  if (!clockEl) return;
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  tick(); setInterval(tick, 1000);
  const yearEl = el('footer-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(str)));
  return d.innerHTML;
}

function labelOf(key) {
  return { light1: 'Lampe Ch.1', light2: 'Lampe Ch.2', fan: 'Ventilateur', lock: 'Serrure' }[key] || key;
}

function initTheme() {
  const saved = localStorage.getItem('sentinel-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next    = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sentinel-theme', next);
}


/* ──────────────────────────────────────────────────────────────────
   16. MODE DÉMO
────────────────────────────────────────────────────────────────── */
let demoTick = 0;

function startDemoMode() {
  addHistoryItem('Mode Démo — Données simulées (Firebase non connecté)', 'info');
  generateDemoTick();
  setInterval(() => { generateDemoTick(); demoTick++; }, CONFIG.chart.demoInterval);
  STATE.isAutoMode = null;
  applyMode(false);
  el('badge-latency').textContent = 'DÉMO';
}

function generateDemoTick() {
  const t    = demoTick;
  const temp = 26 + Math.sin(t * 0.3) * 5  + Math.random() * 1.5;
  const hum  = 55 + Math.sin(t * 0.2) * 10 + Math.random() * 2;
  const lux  = Math.max(0, 320 + Math.sin(t * 0.1) * 150 + Math.random() * 30);
  const pres = 1013 + Math.sin(t * 0.05) * 5 + Math.random() * 0.3;
  const iaq  = 60  + Math.sin(t * 0.15) * 40 + Math.random() * 10;
  const co2  = 700 + Math.sin(t * 0.1) * 200 + Math.random() * 50;
  const iaqAcc = Math.floor((t % 8) / 2.5);  // Alterne 0,1,2,3

  // Clés Firebase exactes
  onSensorData({
    temp:     parseFloat(temp.toFixed(1)),
    hum:      parseFloat(hum.toFixed(1)),
    lux:      Math.round(lux),
    pression: parseFloat(pres.toFixed(1)),  // clé "pression"
    iaq:      parseFloat(iaq.toFixed(1)),
    co2:      parseFloat(co2.toFixed(0)),
    iaqAcc:   iaqAcc
  });

  if (STATE.actuators.light1 === null) {
    onActuatorData({ light1: false, light2: false, fan: false, lock: true });
  }
}


/* ──────────────────────────────────────────────────────────────────
   17. LISTENERS BOUTONS
────────────────────────────────────────────────────────────────── */

function attachUIListeners() {
  // Mode AUTO / MANUEL
  el('btn-mode-auto')  ?.addEventListener('click', () => { if (STATE.isAutoMode !== true)  sendModeCommand(true); });
  el('btn-mode-manual')?.addEventListener('click', () => { if (STATE.isAutoMode !== false) sendModeCommand(false); });

  // Thème
  el('theme-toggle')?.addEventListener('click', toggleTheme);

  // Effacer historique
  el('btn-clear-history')?.addEventListener('click', () => {
    STATE.history = [];
    Array.from(document.querySelectorAll('#history-panel .history-item')).forEach(e => e.remove());
    const empty = el('history-empty');
    if (empty) empty.style.display = '';
    showToast('Journal effacé', 'info');
  });
}


/* ──────────────────────────────────────────────────────────────────
   18. BOOTSTRAP
────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  startClock();
  initChart();
  attachUIListeners();
  initFirebase();
  addHistoryItem('SmartHome Sentinel démarré · Moov Africa 5G', 'info');
  console.log('[Sentinel] Démarrage — Dashboard IoT propulsé par Moov Africa 5G');
});
