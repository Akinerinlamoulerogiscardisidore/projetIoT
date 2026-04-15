/**
 * ══════════════════════════════════════════════════════════════════
 *  SIL — Sentinelle Intelligente de Laboratoire
 *  Dashboard · app.js · Version 9.0
 *  Architecture : Maître-Esclave (Dashboard = décideur unique)
 * ══════════════════════════════════════════════════════════════════
 *
 *  RÔLE DU DASHBOARD (v9.0)
 *  ─────────────────────────
 *  ✔ LIT  les données capteurs depuis Firebase (temps réel)
 *  ✔ AFFICHE température, humidité, pression, luminosité, IAQ, CO₂
 *  ✔ ÉCRIT les commandes actionneurs dans Firebase
 *  ✔ CONTIENT la logique AUTO (seuil + hystérésis thermique)
 *  ✔ ÉCRIT SIL/mode_auto (seul décideur du mode)
 *
 *  CE QUE NE FAIT PLUS LE DASHBOARD :
 *  ✗ Ne lit pas les états actionneurs pour "confirmer" une commande
 *    (l'Arduino agit dès réception, pas besoin de retour)
 *
 *  FLUX FIREBASE
 *  ─────────────
 *  Firebase → Dashboard : SIL/telemetrie/* (lecture temps réel)
 *  Dashboard → Firebase : SIL/etat/*        (commandes)
 *                          SIL/mode_auto    (mode)
 *  Firebase → Arduino   : SIL/etat/*        (exécution polling 500ms)
 *
 *  LOGIQUE AUTO (côté Dashboard)
 *  ──────────────────────────────
 *  À chaque mise à jour de température :
 *  · Si AUTO et T° > SEUIL_ON  (30°C) → écrire SIL/etat/fan = true
 *  · Si AUTO et T° < SEUIL_OFF (28.5°C) → écrire SIL/etat/fan = false
 *  L'Arduino lit et applique dans les 500ms suivantes.
 * ══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ──────────────────────────────────────────────────────────────
   1. CONFIGURATION FIREBASE
────────────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyC3v3xktfmWzzNE0mjOKW9mtSeUoTPQpE4',
  authDomain:        'sentinelle-sil.firebaseapp.com',
  databaseURL:       'https://sentinelle-sil-default-rtdb.firebaseio.com',
  projectId:         'sentinelle-sil',
  storageBucket:     'sentinelle-sil.firebasestorage.app',
  messagingSenderId: '621756722754',
  appId:             '1:621756722754:web:8e9b196ae97d13686cc7db'
};

const DB = {
  telemetry: 'SIL/telemetrie',
  commands:  'SIL/etat',
  mode:      'SIL/mode_auto'
};


/* ──────────────────────────────────────────────────────────────
   2. CONFIGURATION SYSTÈME
────────────────────────────────────────────────────────────── */
const CONFIG = {
  // Seuils d'alerte Dashboard
  temp:  { warn: 28, danger: 35 },
  hum:   { warn: 65, danger: 80 },
  iaq:   { warn: 100, danger: 200 },
  co2:   { warn: 1000, danger: 2000 },

  // Seuils logique AUTO (hystérésis thermique)
  auto: {
    fanOn:  30.0,   // °C — démarrer le ventilateur
    fanOff: 28.5    // °C — arrêter le ventilateur
  },

  chart:   { maxPoints: 30, demoInterval: 5000 },
  history: { maxItems: 50 },
  demo:    { enabled: true }
};


/* ──────────────────────────────────────────────────────────────
   3. ÉTAT CENTRALISÉ (Store)
────────────────────────────────────────────────────────────── */
const STATE = {
  firebase:   { connected: false, db: null },

  // Données capteurs (lues depuis Firebase)
  sensors: {
    temperature: null,  // °C
    humidity:    null,  // %
    pressure:    null,  // hPa
    light:       null,  // lux approx
    iaq:         null,  // IAQ statique (0-500)
    co2:         null,  // CO₂ éq. ppm
    lastUpdate:  null
  },

  // États actionneurs (miroir local — mis à jour par le listener Firebase)
  actuators: {
    fan:   null,
    power: null,
    lamp:  null
  },

  isAutoMode:  null,   // null=inconnu, true=AUTO, false=MANUEL
  alerts:      [],
  history:     [],
  prevSensors: {},
  chart: { labels: [], tempData: [], humData: [] }
};


/* ──────────────────────────────────────────────────────────────
   4. FIREBASE — Initialisation & Listeners
────────────────────────────────────────────────────────────── */

function initFirebase() {
  const configured = FIREBASE_CONFIG.apiKey !== 'VOTRE_API_KEY';

  if (configured) {
    try {
      const app = firebase.initializeApp(FIREBASE_CONFIG);
      STATE.firebase.db = firebase.database(app);
      attachListeners();
    } catch (err) {
      console.error('[SIL] Firebase init error:', err);
      setFirebaseStatus(false);
      if (CONFIG.demo.enabled) startDemoMode();
    }
  } else {
    console.warn('[SIL] Firebase non configuré → Mode démo');
    setFirebaseStatus(false, 'Démo');
    if (CONFIG.demo.enabled) startDemoMode();
  }
}

function attachListeners() {
  const db = STATE.firebase.db;

  // Connexion Firebase
  firebase.database().ref('.info/connected').on('value', snap => {
    const ok = snap.val() === true;
    STATE.firebase.connected = ok;
    setFirebaseStatus(ok);
  });

  // ── Télémétrie capteurs (Arduino → Firebase → Dashboard) ──
  // Chaque mise à jour déclenche la logique AUTO si applicable.
  db.ref(DB.telemetry).on('value', snap => {
    const data = snap.val();
    if (data) onSensorData(data);
  }, err => console.error('[SIL] telemetrie:', err));

  // ── Actionneurs (Dashboard → Firebase → miroir local) ──
  // Sert uniquement à synchroniser l'affichage des boutons.
  db.ref(DB.commands).on('value', snap => {
    const data = snap.val();
    if (data) onActuatorData(data);
  }, err => console.error('[SIL] etat:', err));

  // ── Mode (Dashboard → Firebase → indicateur) ──
  db.ref(DB.mode).on('value', snap => {
    if (snap.val() !== null) applyMode(Boolean(snap.val()));
  }, err => console.error('[SIL] mode_auto:', err));
}


/* ──────────────────────────────────────────────────────────────
   5. TRAITEMENT DES DONNÉES CAPTEURS
────────────────────────────────────────────────────────────── */

function onSensorData(data) {
  const prev = { ...STATE.sensors };

  // Mapping clés Arduino → état JS
  STATE.sensors.temperature = data.temp !== undefined ? parseFloat(data.temp)  : null;
  STATE.sensors.humidity    = data.hum  !== undefined ? parseFloat(data.hum)   : null;
  STATE.sensors.pressure    = data.pres !== undefined ? parseFloat(data.pres)  : null;
  STATE.sensors.light       = data.lux  !== undefined ? parseFloat(data.lux)   : null;
  STATE.sensors.iaq         = data.iaq  !== undefined ? parseFloat(data.iaq)   : null;
  STATE.sensors.co2         = data.co2  !== undefined ? parseFloat(data.co2)   : null;
  STATE.sensors.lastUpdate  = new Date();

  renderSensorCards();
  checkAlerts(prev);
  updateChart();
  updateGlobalStatus();
  updateTimestamp();

  // ── LOGIQUE AUTO (Dashboard-side) ──────────────────────────
  // Si le mode AUTO est actif, on évalue la température et
  // on envoie la commande fan si le seuil est franchi.
  runAutoLogic();
}

/**
 * Logique automatique côté Dashboard.
 * Remplace totalement l'ancienne logique embarquée de l'Arduino.
 * Écriture dans Firebase → Arduino lit et applique en 500ms.
 */
function runAutoLogic() {
  if (STATE.isAutoMode !== true) return;

  const db   = STATE.firebase.db;
  const temp = STATE.sensors.temperature;
  if (!db || temp === null) return;

  const fanOn  = STATE.actuators.fan;

  if (temp > CONFIG.auto.fanOn && fanOn !== true) {
    // Température critique → activer le ventilateur
    db.ref(`${DB.commands}/fan`).set(true).then(() => {
      addHistoryItem(`AUTO — Ventilateur activé (${temp.toFixed(1)} °C > ${CONFIG.auto.fanOn} °C)`, 'fan');
      showToast(`Ventilateur activé automatiquement`, 'info');
    });
  } else if (temp < CONFIG.auto.fanOff && fanOn !== false) {
    // Température revenue à la normale → couper le ventilateur
    db.ref(`${DB.commands}/fan`).set(false).then(() => {
      addHistoryItem(`AUTO — Ventilateur arrêté (${temp.toFixed(1)} °C < ${CONFIG.auto.fanOff} °C)`, 'fan');
    });
  }
}


/* ──────────────────────────────────────────────────────────────
   6. TRAITEMENT DES ÉTATS ACTIONNEURS
────────────────────────────────────────────────────────────── */

function onActuatorData(data) {
  const prevFan   = STATE.actuators.fan;
  const prevPower = STATE.actuators.power;
  const prevLamp  = STATE.actuators.lamp;

  STATE.actuators.fan   = data.fan   !== undefined ? Boolean(data.fan)   : null;
  STATE.actuators.power = data.alim  !== undefined ? Boolean(data.alim)  : null;
  STATE.actuators.lamp  = data.lampe !== undefined ? Boolean(data.lampe) : null;

  renderActuatorRows();
  syncCmdButtons();

  // Historique des transitions (ignorer le premier remplissage null→valeur)
  if (prevFan   !== null && prevFan   !== STATE.actuators.fan) {
    addHistoryItem(`Ventilateur ${STATE.actuators.fan ? 'activé' : 'arrêté'}`, 'fan');
    showToast(`Ventilateur ${STATE.actuators.fan ? 'activé' : 'arrêté'}`, STATE.actuators.fan ? 'ok' : 'info');
  }
  if (prevPower !== null && prevPower !== STATE.actuators.power) {
    addHistoryItem(`Alimentation ${STATE.actuators.power ? 'rétablie' : 'coupée'}`, 'relay');
    showToast(`Alimentation ${STATE.actuators.power ? 'rétablie' : 'coupée'}`, STATE.actuators.power ? 'ok' : 'warn');
  }
  if (prevLamp  !== null && prevLamp  !== STATE.actuators.lamp) {
    addHistoryItem(`Lampe ${STATE.actuators.lamp ? 'allumée' : 'éteinte'}`, 'lamp');
    showToast(`Lampe ${STATE.actuators.lamp ? 'allumée' : 'éteinte'}`, STATE.actuators.lamp ? 'ok' : 'info');
  }

  updateGlobalStatus();
}


/* ──────────────────────────────────────────────────────────────
   7. RENDU — Cartes capteurs
────────────────────────────────────────────────────────────── */

function renderSensorCards() {
  const { temperature, humidity, pressure, light, iaq, co2 } = STATE.sensors;

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
    cardId: 'card-pres', valueId: 'pres-value', trendId: 'pres-trend',
    value: pressure, unit: ' hPa',
    warnAt: null, dangerAt: null,   // Pas de seuil critique pour la pression
    prev: STATE.prevSensors.pressure,
    decimals: 1
  });

  renderSensorCard({
    cardId: 'card-lux', valueId: 'lux-value', trendId: 'lux-trend',
    value: light, unit: ' lx',
    warnAt: null, dangerAt: null,
    prev: STATE.prevSensors.light
  });

  // Carte IAQ — rendu spécifique
  renderIAQCard(iaq, co2);

  STATE.prevSensors = { temperature, humidity, pressure, light, iaq, co2 };
}

function renderSensorCard({ cardId, valueId, trendId, value, unit, warnAt, dangerAt, prev, decimals = 1 }) {
  const card    = el(cardId);
  const valueEl = el(valueId);
  const trendEl = el(trendId);
  if (!card || !valueEl) return;

  if (value === null || value === undefined || isNaN(value)) {
    valueEl.textContent = 'N/A';
    card.className = 'sensor-card';
    return;
  }

  const fmt = Number.isInteger(value) ? String(value) : value.toFixed(decimals);
  valueEl.textContent = fmt + unit;
  valueEl.classList.remove('value-updated');
  void valueEl.offsetWidth;
  valueEl.classList.add('value-updated');

  card.className = 'sensor-card';
  if (dangerAt !== null && value >= dangerAt)      card.classList.add('state-danger');
  else if (warnAt !== null && value >= warnAt)     card.classList.add('state-warn');
  else                                              card.classList.add('state-ok');

  if (trendEl && prev !== null && prev !== undefined) {
    const diff = value - prev;
    if (Math.abs(diff) > 0.05) {
      trendEl.textContent = `${diff > 0 ? '↑' : '↓'} ${diff > 0 ? '+' : ''}${diff.toFixed(1)}${unit}`;
      trendEl.style.color = diff > 0 ? 'var(--orange)' : 'var(--blue)';
    }
  }
}

function renderIAQCard(iaq, co2) {
  const card    = el('card-iaq');
  const iaqEl   = el('iaq-value');
  const co2El   = el('co2-value');
  const badge   = el('iaq-badge');
  if (!card || !iaqEl) return;

  // Valeur IAQ
  if (iaq === null || isNaN(iaq)) {
    iaqEl.textContent = 'N/A';
    card.className = 'sensor-card sensor-card--wide';
    if (badge) badge.textContent = '–';
  } else {
    iaqEl.textContent = iaq.toFixed(0);
    iaqEl.classList.remove('value-updated');
    void iaqEl.offsetWidth;
    iaqEl.classList.add('value-updated');

    // Classification IAQ et état visuel
    let cls, label, badgeCls;
    if (iaq <= 50)       { cls = 'state-ok';     label = 'Excellent'; badgeCls = 'iaq-excellent'; }
    else if (iaq <= 100) { cls = 'state-ok';     label = 'Bon';       badgeCls = 'iaq-good'; }
    else if (iaq <= 150) { cls = 'state-warn';   label = 'Modéré';    badgeCls = 'iaq-moderate'; }
    else if (iaq <= 200) { cls = 'state-warn';   label = 'Dégradé';   badgeCls = 'iaq-moderate'; }
    else                 { cls = 'state-danger'; label = 'Mauvais';   badgeCls = 'iaq-poor'; }

    card.className = `sensor-card sensor-card--wide ${cls}`;
    if (badge) {
      badge.textContent = label;
      badge.className   = `iaq-badge ${badgeCls}`;
    }
  }

  // Valeur CO₂
  if (co2El) {
    co2El.textContent = co2 !== null && !isNaN(co2) ? co2.toFixed(0) : 'N/A';
    co2El.style.color = co2 !== null && co2 > CONFIG.co2.danger ? 'var(--red)'
                       : co2 !== null && co2 > CONFIG.co2.warn  ? 'var(--orange)'
                       : 'var(--text-2)';
  }
}


/* ──────────────────────────────────────────────────────────────
   8. RENDU — Actionneurs
────────────────────────────────────────────────────────────── */

function renderActuatorRows() {
  const { fan, power, lamp } = STATE.actuators;
  renderActuatorRow('act-lamp',  'lamp-value',  'lamp-led',  lamp,  'Allumée',  'Éteinte');
  renderActuatorRow('act-fan',   'fan-value',   'fan-led',   fan,   'En marche','Arrêté');
  renderActuatorRow('act-power', 'power-value', 'power-led', power, 'Alimenté', 'Coupé');
}

function renderActuatorRow(rowId, valueId, ledId, value, labelOn, labelOff) {
  const row   = el(rowId);
  const valEl = el(valueId);
  if (!row || !valEl) return;

  row.classList.remove('state-on', 'state-off');

  if (value === null) {
    valEl.textContent = '–';
    return;
  }
  row.classList.add(value ? 'state-on' : 'state-off');
  valEl.textContent = value ? labelOn : labelOff;
}

function syncCmdButtons() {
  syncBtnPair('lampe', STATE.actuators.lamp);
  syncBtnPair('fan',   STATE.actuators.fan);

  const pwrBtn = el('btn-power-toggle');
  if (pwrBtn && STATE.actuators.power !== null) {
    pwrBtn.setAttribute('data-active', STATE.actuators.power ? 'true' : 'false');
  }
}

function syncBtnPair(name, state) {
  const on  = el(`btn-${name}-on`);
  const off = el(`btn-${name}-off`);
  if (!on || !off) return;
  on.setAttribute( 'data-active', state === true  ? 'true' : 'false');
  off.setAttribute('data-active', state === false ? 'true' : 'false');
}


/* ──────────────────────────────────────────────────────────────
   9. GESTION DU MODE
────────────────────────────────────────────────────────────── */

function applyMode(isAuto) {
  if (STATE.isAutoMode === isAuto) return;
  const wasNull = STATE.isAutoMode === null;
  STATE.isAutoMode = isAuto;

  const btnAuto   = el('btn-mode-auto');
  const btnManual = el('btn-mode-manual');
  if (btnAuto)   { btnAuto.classList.toggle('mode-btn--active',   isAuto);  btnAuto.setAttribute('aria-pressed',   String(isAuto)); }
  if (btnManual) { btnManual.classList.toggle('mode-btn--active', !isAuto); btnManual.setAttribute('aria-pressed', String(!isAuto)); }

  const descEl = el('mode-desc');
  if (descEl) {
    descEl.textContent = isAuto
      ? 'Le Dashboard surveille les capteurs et pilote le ventilateur de façon autonome. Aucune commande manuelle n\'est possible.'
      : 'Vous êtes aux commandes. Utilisez les boutons ci-dessous pour piloter les actionneurs.';
  }

  const overlay = el('auto-lock-overlay');
  if (overlay) overlay.classList.toggle('visible', isAuto);

  if (!wasNull) {
    addHistoryItem(`Mode → ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info');
    showToast(`Mode ${isAuto ? 'AUTO actif' : 'MANUEL actif'}`, isAuto ? 'info' : 'ok');
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


/* ──────────────────────────────────────────────────────────────
   10. GRAPHIQUE (Chart.js)
────────────────────────────────────────────────────────────── */
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
        { ...shared, label: 'Température (°C)', data: [], borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.05)', yAxisID: 'yT' },
        { ...shared, label: 'Humidité (%)',      data: [], borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.05)',   yAxisID: 'yH' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#181d2c', borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1,
          titleColor: '#dde2ec', bodyColor: '#7c8598',
          padding: 11, cornerRadius: 6,
          callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? 'N/A'}` }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#4a5266', font: { size: 10, family: 'IBM Plex Mono' }, maxTicksLimit: 8 } },
        yT: { type: 'linear', position: 'left',  grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#f87171', font: { size: 10 }, callback: v => v + '°' } },
        yH: { type: 'linear', position: 'right', grid: { display: false }, ticks: { color: '#60a5fa', font: { size: 10 }, callback: v => v + '%' }, min: 0, max: 100 }
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

  const emptyEl = el('chart-empty');
  if (emptyEl) emptyEl.classList.add('hidden');
}


/* ──────────────────────────────────────────────────────────────
   11. ALERTES
────────────────────────────────────────────────────────────── */

function checkAlerts(prev) {
  const { temperature, humidity, iaq, co2 } = STATE.sensors;
  const alerts = [];

  const addAlert = (type, msg) => alerts.push({ type, msg });

  if (temperature !== null) {
    if (temperature >= CONFIG.temp.danger) addAlert('danger', `Température critique : ${temperature.toFixed(1)} °C`);
    else if (temperature >= CONFIG.temp.warn) addAlert('warn', `Température élevée : ${temperature.toFixed(1)} °C`);
  }
  if (humidity !== null) {
    if (humidity >= CONFIG.hum.danger) addAlert('danger', `Humidité critique : ${humidity.toFixed(1)} %`);
    else if (humidity >= CONFIG.hum.warn) addAlert('warn', `Humidité élevée : ${humidity.toFixed(1)} %`);
  }
  if (iaq !== null) {
    if (iaq >= CONFIG.iaq.danger) addAlert('danger', `Qualité d'air très dégradée : IAQ ${iaq.toFixed(0)}`);
    else if (iaq >= CONFIG.iaq.warn) addAlert('warn', `Qualité d'air modérée : IAQ ${iaq.toFixed(0)}`);
  }
  if (co2 !== null) {
    if (co2 >= CONFIG.co2.danger) addAlert('danger', `CO₂ élevé : ${co2.toFixed(0)} ppm`);
    else if (co2 >= CONFIG.co2.warn) addAlert('warn', `CO₂ modéré : ${co2.toFixed(0)} ppm`);
  }

  // Enregistrer les nouveaux seuils critiques
  if (temperature !== null && (prev.temperature || 0) < CONFIG.temp.danger && temperature >= CONFIG.temp.danger) {
    addHistoryItem(`⚠ Température critique : ${temperature.toFixed(1)} °C`, 'temp');
  }

  STATE.alerts = alerts;
  renderAlerts();
  updateGlobalStatus();
}

function renderAlerts() {
  const panel  = el('alerts-panel');
  const empty  = el('alerts-empty');
  const badge  = el('alert-count');
  if (!panel) return;

  Array.from(panel.querySelectorAll('.alert-item')).forEach(e => e.remove());

  if (STATE.alerts.length === 0) {
    if (empty) empty.style.display = '';
    if (badge) { badge.classList.remove('visible'); badge.textContent = ''; }
    return;
  }

  if (empty) empty.style.display = 'none';
  if (badge) { badge.textContent = STATE.alerts.length; badge.classList.add('visible'); }

  const iconW = `<svg style="width:14px;height:14px;flex-shrink:0;margin-top:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const iconD = `<svg style="width:14px;height:14px;flex-shrink:0;margin-top:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  STATE.alerts.forEach(a => {
    const div = document.createElement('div');
    div.className = `alert-item alert-item--${a.type}`;
    div.innerHTML = (a.type === 'danger' ? iconD : iconW) + `<span>${escapeHtml(a.msg)}</span>`;
    panel.appendChild(div);
  });
}

function updateGlobalStatus() {
  const badge = el('global-status');
  const label = el('global-status-label');
  if (!badge || !label) return;

  const dangers = STATE.alerts.filter(a => a.type === 'danger').length;
  const warns   = STATE.alerts.filter(a => a.type === 'warn').length;

  badge.className = 'hdr-pill hdr-pill--status';

  if (dangers > 0)                          { badge.classList.add('danger'); label.textContent = 'CRITIQUE'; }
  else if (warns > 0)                       { badge.classList.add('warn');   label.textContent = 'ALERTE'; }
  else if (STATE.sensors.temperature !== null) { badge.classList.add('ok'); label.textContent = 'NOMINAL'; }
  else                                      { label.textContent = 'EN ATTENTE'; }
}


/* ──────────────────────────────────────────────────────────────
   12. HISTORIQUE
────────────────────────────────────────────────────────────── */

function addHistoryItem(message, type = 'info') {
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const item = { time, message, type };
  STATE.history.unshift(item);
  if (STATE.history.length > CONFIG.history.maxItems) STATE.history.pop();

  const panel   = el('history-panel');
  const emptyEl = el('history-empty');
  if (!panel) return;

  const div = document.createElement('div');
  div.className = 'history-item';
  div.innerHTML = `<span class="history-time">${escapeHtml(time)}</span><span class="history-msg">${escapeHtml(message)}</span>`;
  panel.insertBefore(div, emptyEl ? emptyEl.nextSibling : panel.firstChild);

  if (emptyEl) emptyEl.style.display = 'none';
}


/* ──────────────────────────────────────────────────────────────
   13. COMMANDES FIREBASE (Dashboard → Firebase → Arduino)
────────────────────────────────────────────────────────────── */

/**
 * Envoie une commande actionneur dans Firebase.
 * L'Arduino lit et applique dans les 500ms suivantes.
 * Clés acceptées : 'lampe' | 'fan' | 'alim'
 */
function sendCommand(actuator, value) {
  const db       = STATE.firebase.db;
  const feedback = el('cmd-feedback');

  // Guard mode AUTO : bloquer commandes manuelles
  if (STATE.isAutoMode === true) {
    setFeedback(feedback, '🔒 Mode AUTO — commandes désactivées', 'warning');
    showToast('Passez en mode Manuel pour piloter', 'warn');
    return;
  }

  if (!db) {
    simulateCommand(actuator, value);
    return;
  }

  setFeedback(feedback, '⏳ Envoi…', '');

  db.ref(`${DB.commands}/${actuator}`).set(value)
    .then(() => {
      setFeedback(feedback, `✓ ${labelOf(actuator)} → ${value ? 'ON' : 'OFF'}`, 'success');
      addHistoryItem(`Web → ${labelOf(actuator)} ${value ? 'ON' : 'OFF'}`, 'relay');
    })
    .catch(err => {
      console.error('[SIL]', err);
      setFeedback(feedback, '✗ Échec', 'error');
      showToast('Erreur Firebase', 'danger');
    });
}

/** Simulation locale (mode démo, sans Firebase) */
function simulateCommand(actuator, value) {
  if (STATE.isAutoMode === true) {
    setFeedback(el('cmd-feedback'), '🔒 Mode AUTO', 'warning');
    return;
  }
  const keyMap = { alim: 'power', fan: 'fan', lampe: 'lamp' };
  const key = keyMap[actuator] || actuator;
  STATE.actuators[key] = value;

  renderActuatorRows();
  syncCmdButtons();

  const msg = `[Démo] ${labelOf(actuator)} ${value ? 'ON' : 'OFF'}`;
  addHistoryItem(msg, 'relay');
  showToast(msg, 'ok');
  setFeedback(el('cmd-feedback'), '[Démo] Appliqué localement', 'warning');
  updateGlobalStatus();
}

function labelOf(act) {
  return { lampe: 'Lampe', fan: 'Ventilateur', alim: 'Alimentation' }[act] || act;
}


/* ──────────────────────────────────────────────────────────────
   14. LISTENERS DES BOUTONS UI
────────────────────────────────────────────────────────────── */

function attachUIListeners() {
  // Commandes actionneurs
  el('btn-lampe-on') ?.addEventListener('click', () => sendCommand('lampe', true));
  el('btn-lampe-off')?.addEventListener('click', () => sendCommand('lampe', false));
  el('btn-fan-on')   ?.addEventListener('click', () => sendCommand('fan',   true));
  el('btn-fan-off')  ?.addEventListener('click', () => sendCommand('fan',   false));

  // Alimentation (confirmation avant coupure)
  el('btn-power-toggle')?.addEventListener('click', () => {
    const cur = STATE.actuators.power;
    if (cur === true) {
      if (confirm('⚠ Couper l\'alimentation externe ?')) sendCommand('alim', false);
    } else {
      sendCommand('alim', true);
    }
  });

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
    showToast('Historique effacé', 'info');
  });
}


/* ──────────────────────────────────────────────────────────────
   15. UTILITAIRES
────────────────────────────────────────────────────────────── */

const el = id => document.getElementById(id);

function setFirebaseStatus(connected, customLabel = null) {
  const badge = el('firebase-status');
  const label = el('firebase-label');
  if (!badge || !label) return;
  badge.classList.remove('connected', 'disconnected');
  badge.classList.add(connected ? 'connected' : 'disconnected');
  label.textContent = customLabel ?? (connected ? 'Firebase connecté' : 'Déconnecté');
}

function showToast(message, type = 'ok', duration = 3200) {
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
  feedEl.className   = 'cmd-feedback' + (cls ? ` ${cls}` : '');
  feedEl.classList.add('visible');
  clearTimeout(feedEl._t);
  feedEl._t = setTimeout(() => feedEl.classList.remove('visible'), 3500);
}

function updateTimestamp() {
  const tsEl = el('last-update-time');
  if (!tsEl || !STATE.sensors.lastUpdate) return;
  tsEl.textContent = STATE.sensors.lastUpdate.toLocaleTimeString('fr-FR');
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

function initTheme() {
  if (localStorage.getItem('sil-theme') === 'light') document.body.classList.add('light-mode');
}

function toggleTheme() {
  const light = document.body.classList.toggle('light-mode');
  localStorage.setItem('sil-theme', light ? 'light' : 'dark');
}


/* ──────────────────────────────────────────────────────────────
   16. MODE DÉMO
────────────────────────────────────────────────────────────── */
let demoTick = 0;

function startDemoMode() {
  addHistoryItem('Mode Démo — Firebase non connecté', 'info');
  generateDemoTick();
  setInterval(() => { generateDemoTick(); demoTick++; }, CONFIG.chart.demoInterval);
  STATE.isAutoMode = null;
  applyMode(false);
}

function generateDemoTick() {
  const t = demoTick;
  const temp = 26 + Math.sin(t * 0.3) * 5  + Math.random() * 1.5;
  const hum  = 55 + Math.sin(t * 0.2) * 10 + Math.random() * 2;
  const pres = 1013 + Math.sin(t * 0.05) * 5 + Math.random() * 0.5;
  const lux  = Math.max(0, 320 + Math.sin(t * 0.1) * 150 + Math.random() * 30);
  const iaq  = 60  + Math.sin(t * 0.15) * 40 + Math.random() * 10;
  const co2  = 700 + Math.sin(t * 0.1)  * 200 + Math.random() * 50;

  // Clés Arduino exactes
  onSensorData({
    temp: parseFloat(temp.toFixed(1)),
    hum:  parseFloat(hum.toFixed(1)),
    pres: parseFloat(pres.toFixed(1)),
    lux:  Math.round(lux),
    iaq:  parseFloat(iaq.toFixed(1)),
    co2:  parseFloat(co2.toFixed(0))
  });

  if (STATE.actuators.fan === null) {
    onActuatorData({ fan: false, alim: true, lampe: false });
  }
}


/* ──────────────────────────────────────────────────────────────
   17. BOOTSTRAP
────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  startClock();
  initChart();
  attachUIListeners();
  initFirebase();
  addHistoryItem('Dashboard SIL v9.0 démarré', 'info');
  console.log('[SIL] v9.0 — Architecture Maître-Esclave initialisée.');
});
