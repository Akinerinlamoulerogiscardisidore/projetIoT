/**
 * ═══════════════════════════════════════════════════════════════════
 *  SIL — Sentinelle Intelligente de Laboratoire
 *  Dashboard  ·  app.js  ·  Version 8.0
 * ═══════════════════════════════════════════════════════════════════
 *
 *  NOUVEAUTÉS v8.0
 *  ───────────────
 *  [A] Bascule AUTO / MANUEL depuis le Dashboard
 *      · sendModeCommand(isAuto) écrit dans SIL/mode_auto
 *      · L'Arduino lit la valeur dans la seconde qui suit
 *      · updateMode(isAuto) met à jour le toggle et le verrou
 *
 *  [B] Correction simulateCommand (bug de clé d'état)
 *      · Table de mapping fbKey → stateKey (alim→power, lampe→lamp…)
 *
 *  [C] updateMode() complet et robuste
 *      · Gère le badge mode + overlay verrou + message descriptif
 *
 *  CORRECTIONS conservées
 *  ──────────────────────
 *  [FIX 3] Listener SIL/mode_auto → mise à jour badge et verrou
 *  [FIX demo] generateDemoData() utilise les bonnes clés (temp/hum/lux)
 * ═══════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────────
   1. CONFIGURATION FIREBASE
───────────────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyC3v3xktfmWzzNE0mjOKW9mtSeUoTPQpE4',
  authDomain:        'sentinelle-sil.firebaseapp.com',
  databaseURL:       'https://sentinelle-sil-default-rtdb.firebaseio.com',
  projectId:         'sentinelle-sil',
  storageBucket:     'sentinelle-sil.firebasestorage.app',
  messagingSenderId: '621756722754',
  appId:             '1:621756722754:web:8e9b196ae97d13686cc7db'
};

const DB_PATHS = {
  sensors:   'SIL/telemetrie',
  actuators: 'SIL/etat',
  mode:      'SIL/mode_auto'
};


/* ─────────────────────────────────────────────────────────────────
   2. CONFIGURATION SYSTÈME
───────────────────────────────────────────────────────────────── */
const CONFIG = {
  thresholds: {
    tempWarn:   28,
    tempDanger: 35,
    humWarn:    65,
    humDanger:  80
  },
  chart: {
    maxPoints:  30,
    intervalMs: 5000   // mode démo
  },
  history: { maxItems: 50 },
  demo:    { enabled: true }
};


/* ─────────────────────────────────────────────────────────────────
   3. ÉTAT CENTRALISÉ (Store)
───────────────────────────────────────────────────────────────── */
const APP_STATE = {
  firebase:   { connected: false, db: null },
  sensors:    { temperature: null, humidity: null, light: null, lastUpdate: null },
  actuators:  { fan: null, power: null, lamp: null },
  isAutoMode: null,          // null = inconnu, true = AUTO, false = MANUEL
  chart:      { labels: [], tempData: [], humData: [] },
  alerts:     [],
  history:    [],
  prevSensors: {}
};


/* ─────────────────────────────────────────────────────────────────
   4. INITIALISATION FIREBASE & LISTENERS
───────────────────────────────────────────────────────────────── */

function initFirebase() {
  const isConfigured = FIREBASE_CONFIG.apiKey !== 'VOTRE_API_KEY';

  if (isConfigured) {
    try {
      const app = firebase.initializeApp(FIREBASE_CONFIG);
      APP_STATE.firebase.db = firebase.database(app);
      attachFirebaseListeners();
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

function attachFirebaseListeners() {
  const db = APP_STATE.firebase.db;

  // Connexion
  firebase.database().ref('.info/connected').on('value', snap => {
    const ok = snap.val() === true;
    APP_STATE.firebase.connected = ok;
    setFirebaseStatus(ok);
  });

  // Capteurs (push toutes les 10 s depuis l'Arduino)
  db.ref(DB_PATHS.sensors).on('value', snap => {
    const data = snap.val();
    if (data) updateSensors(data);
  }, err => {
    console.error('[SIL] Erreur capteurs:', err);
    addHistoryItem('Erreur lecture capteurs Firebase', 'info');
  });

  // Actionneurs (push immédiat depuis l'Arduino)
  db.ref(DB_PATHS.actuators).on('value', snap => {
    const data = snap.val();
    if (data) updateActuators(data);
  }, err => {
    console.error('[SIL] Erreur actionneurs:', err);
  });

  // Mode AUTO / MANUEL — listener temps réel
  db.ref(DB_PATHS.mode).on('value', snap => {
    if (snap.val() === null) return;
    const isAuto = Boolean(snap.val());
    updateMode(isAuto);
  }, err => {
    console.error('[SIL] Erreur mode_auto:', err);
  });
}


/* ─────────────────────────────────────────────────────────────────
   5. CONTRÔLEURS UI
───────────────────────────────────────────────────────────────── */

/* ── Capteurs ── */
function updateSensors(data) {
  const prev = { ...APP_STATE.sensors };

  // Mapping clés Arduino → JS
  APP_STATE.sensors.temperature = (data.temp !== undefined) ? parseFloat(data.temp) : null;
  APP_STATE.sensors.humidity    = (data.hum  !== undefined) ? parseFloat(data.hum)  : null;
  APP_STATE.sensors.light       = (data.lux  !== undefined) ? parseFloat(data.lux)  : null;
  APP_STATE.sensors.lastUpdate  = new Date();

  renderSensorCards();
  checkAlerts(prev);
  updateChart();
  updateGlobalStatus();
  updateLastUpdateTime();
}

/* ── Actionneurs ── */
function updateActuators(data) {
  const prevFan   = APP_STATE.actuators.fan;
  const prevPower = APP_STATE.actuators.power;
  const prevLamp  = APP_STATE.actuators.lamp;

  // Mapping clés Arduino → clés JS du state
  APP_STATE.actuators.fan   = (data.fan   !== undefined) ? Boolean(data.fan)   : null;
  APP_STATE.actuators.power = (data.alim  !== undefined) ? Boolean(data.alim)  : null;
  APP_STATE.actuators.lamp  = (data.lampe !== undefined) ? Boolean(data.lampe) : null;

  renderActuatorItems();
  syncCmdButtons();

  // Historique des transitions
  if (prevFan   !== null && prevFan   !== APP_STATE.actuators.fan) {
    const s = APP_STATE.actuators.fan ? 'activé' : 'désactivé';
    addHistoryItem(`Ventilateur ${s}`, 'fan');
    showToast(`Ventilateur ${s}`, APP_STATE.actuators.fan ? 'ok' : 'info');
  }
  if (prevPower !== null && prevPower !== APP_STATE.actuators.power) {
    const s = APP_STATE.actuators.power ? 'rétablie' : 'coupée';
    addHistoryItem(`Alimentation ${s}`, 'relay');
    showToast(`Alimentation ${s}`, APP_STATE.actuators.power ? 'ok' : 'warn');
  }
  if (prevLamp  !== null && prevLamp  !== APP_STATE.actuators.lamp) {
    const s = APP_STATE.actuators.lamp ? 'allumée' : 'éteinte';
    addHistoryItem(`Lampe ${s}`, 'lamp');
    showToast(`Lampe ${s}`, APP_STATE.actuators.lamp ? 'ok' : 'info');
  }

  updateGlobalStatus();
}

/* ── Mode AUTO / MANUEL ── [C] */
function updateMode(isAuto) {
  if (APP_STATE.isAutoMode === isAuto) return; // Pas de changement

  const wasNull = APP_STATE.isAutoMode === null;
  APP_STATE.isAutoMode = isAuto;

  // Boutons du mode switch
  const btnAuto   = document.getElementById('btn-mode-auto');
  const btnManual = document.getElementById('btn-mode-manual');
  if (btnAuto && btnManual) {
    btnAuto.classList.toggle('mode-btn--active',   isAuto);
    btnManual.classList.toggle('mode-btn--active', !isAuto);
  }

  // Description
  const descEl = document.getElementById('mode-desc');
  if (descEl) {
    descEl.textContent = isAuto
      ? "L'Arduino surveille et contrôle les actionneurs de façon autonome. Aucune commande manuelle n'est acceptée."
      : 'Vous êtes aux commandes. Utilisez les boutons ci-dessous ou les touches tactiles TOUCH 0–3.';
  }

  // Source tag
  const sourceTag = document.getElementById('mode-source-tag');
  if (sourceTag) sourceTag.textContent = 'Arduino';

  // Overlay verrou sur les commandes
  const overlay = document.getElementById('auto-lock-overlay');
  if (overlay) {
    overlay.classList.toggle('visible', isAuto);
  }

  // Historique (pas au chargement initial)
  if (!wasNull) {
    addHistoryItem(`Mode → ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info');
    showToast(`Mode ${isAuto ? 'AUTO' : 'MANUEL'} actif`, isAuto ? 'info' : 'ok');
  }
}

/* ── Rendu cartes capteurs ── */
function renderSensorCards() {
  const { temperature, humidity, light } = APP_STATE.sensors;

  renderSensorCard({
    cardId:   'card-temp', valueId: 'temp-value', trendId: 'temp-trend',
    value:     temperature, unit: '°C',
    warnAt:    CONFIG.thresholds.tempWarn, dangerAt: CONFIG.thresholds.tempDanger,
    prevValue: APP_STATE.prevSensors.temperature
  });

  renderSensorCard({
    cardId:   'card-hum', valueId: 'hum-value', trendId: 'hum-trend',
    value:     humidity, unit: '%',
    warnAt:    CONFIG.thresholds.humWarn, dangerAt: CONFIG.thresholds.humDanger,
    prevValue: APP_STATE.prevSensors.humidity
  });

  renderSensorCard({
    cardId:   'card-lux', valueId: 'lux-value', trendId: 'lux-trend',
    value:     light, unit: ' lx',
    warnAt:    null, dangerAt: null,
    prevValue: APP_STATE.prevSensors.light
  });

  APP_STATE.prevSensors = { temperature, humidity, light };
}

function renderSensorCard({ cardId, valueId, trendId, value, unit, warnAt, dangerAt, prevValue }) {
  const card    = document.getElementById(cardId);
  const valueEl = document.getElementById(valueId);
  const trendEl = document.getElementById(trendId);
  if (!card || !valueEl) return;

  if (value === null || value === undefined || isNaN(value)) {
    valueEl.textContent = 'N/A';
    card.className = 'sensor-card';
    return;
  }

  const fmt = Number.isInteger(value) ? value : value.toFixed(1);
  valueEl.textContent = fmt + unit;
  valueEl.classList.remove('value-updated');
  void valueEl.offsetWidth;
  valueEl.classList.add('value-updated');

  card.className = 'sensor-card';
  if (dangerAt !== null && value >= dangerAt) {
    card.classList.add('state-danger');
  } else if (warnAt !== null && value >= warnAt) {
    card.classList.add('state-warn');
  } else {
    card.classList.add('state-ok');
  }

  if (trendEl && prevValue !== null && prevValue !== undefined) {
    const diff = value - prevValue;
    if (Math.abs(diff) > 0.1) {
      const dir   = diff > 0 ? '↑' : '↓';
      const sign  = diff > 0 ? '+' : '';
      trendEl.textContent = `${dir} ${sign}${diff.toFixed(1)}${unit}`;
      trendEl.style.color = diff > 0 ? 'var(--orange)' : 'var(--auto-clr)';
    }
  }
}

/* ── Rendu actionneurs (strip + boutons) ── */
function renderActuatorItems() {
  renderActuatorItem('card-lamp',  'lamp-value',  'lamp-dot',  APP_STATE.actuators.lamp,  'Lampe allumée', 'Lampe éteinte');
  renderActuatorItem('card-fan',   'fan-value',   'fan-dot',   APP_STATE.actuators.fan,   'En marche',     'Arrêté');
  renderActuatorItem('card-power', 'power-value', 'power-dot', APP_STATE.actuators.power, 'Alimenté',      'Coupé');
}

function renderActuatorItem(cardId, valueId, dotId, value, labelOn, labelOff) {
  const card    = document.getElementById(cardId);
  const valueEl = document.getElementById(valueId);
  if (!card || !valueEl) return;

  if (value === null || value === undefined) {
    valueEl.textContent = '–';
    card.className = card.className.replace(/state-\w+/g, '').trim();
    return;
  }

  card.classList.remove('state-on', 'state-off');
  card.classList.add(value ? 'state-on' : 'state-off');
  valueEl.textContent = value ? labelOn : labelOff;
}

/* ── Sync boutons commandes ── */
function syncCmdButtons() {
  syncPairBtn('lampe', APP_STATE.actuators.lamp);
  syncPairBtn('fan',   APP_STATE.actuators.fan);

  const powerBtn = document.getElementById('btn-power-toggle');
  if (powerBtn && APP_STATE.actuators.power !== null) {
    powerBtn.setAttribute('data-active', APP_STATE.actuators.power ? 'true' : 'false');
  }
}

function syncPairBtn(name, state) {
  const on  = document.getElementById(`btn-${name}-on`);
  const off = document.getElementById(`btn-${name}-off`);
  if (!on || !off) return;

  on.setAttribute( 'data-active', state === true  ? 'true' : 'false');
  off.setAttribute('data-active', state === false ? 'true' : 'false');
}


/* ─────────────────────────────────────────────────────────────────
   6. GRAPHIQUE (Chart.js)
───────────────────────────────────────────────────────────────── */
let envChart = null;

function initChart() {
  const ctx = document.getElementById('envChart');
  if (!ctx) return;

  const sharedOpts = {
    tension: 0.4, pointRadius: 2, pointHoverRadius: 5,
    borderWidth: 2, fill: true, spanGaps: true
  };

  envChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          ...sharedOpts,
          label: 'Température (°C)',
          data: [],
          borderColor: '#f87171',
          backgroundColor: 'rgba(248,113,113,0.06)',
          yAxisID: 'yTemp'
        },
        {
          ...sharedOpts,
          label: 'Humidité (%)',
          data: [],
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.06)',
          yAxisID: 'yHum'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#181d2c',
          borderColor: '#ffffff10',
          borderWidth: 1,
          titleColor: '#dde2ec',
          bodyColor: '#7c8598',
          padding: 12,
          cornerRadius: 6,
          callbacks: {
            label: c => ` ${c.dataset.label}: ${c.parsed.y?.toFixed(1) ?? 'N/A'}`
          }
        }
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: { color: '#4a5266', font: { size: 10, family: 'IBM Plex Mono' }, maxTicksLimit: 8 }
        },
        yTemp: {
          type:     'linear',
          position: 'left',
          grid:     { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks:    { color: '#f87171', font: { size: 10 }, callback: v => v + '°' }
        },
        yHum: {
          type:     'linear',
          position: 'right',
          grid:     { display: false },
          ticks:    { color: '#60a5fa', font: { size: 10 }, callback: v => v + '%' },
          min: 0, max: 100
        }
      }
    }
  });
}

function updateChart() {
  if (!envChart) return;
  const { temperature, humidity } = APP_STATE.sensors;
  if (temperature === null && humidity === null) return;

  const label = (APP_STATE.sensors.lastUpdate || new Date())
    .toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  if (APP_STATE.chart.labels.length >= CONFIG.chart.maxPoints) {
    APP_STATE.chart.labels.shift();
    APP_STATE.chart.tempData.shift();
    APP_STATE.chart.humData.shift();
  }

  APP_STATE.chart.labels.push(label);
  APP_STATE.chart.tempData.push(temperature ?? null);
  APP_STATE.chart.humData.push(humidity    ?? null);

  envChart.data.labels           = APP_STATE.chart.labels;
  envChart.data.datasets[0].data = APP_STATE.chart.tempData;
  envChart.data.datasets[1].data = APP_STATE.chart.humData;
  envChart.update('none');

  const emptyEl = document.getElementById('chart-empty');
  if (emptyEl) emptyEl.classList.add('hidden');
}


/* ─────────────────────────────────────────────────────────────────
   7. ALERTES
───────────────────────────────────────────────────────────────── */
function checkAlerts(prevSensors) {
  const { temperature, humidity } = APP_STATE.sensors;
  const newAlerts = [];

  if (temperature !== null) {
    if (temperature >= CONFIG.thresholds.tempDanger) {
      newAlerts.push({ type: 'danger', msg: `Température critique : ${temperature.toFixed(1)}°C (seuil ${CONFIG.thresholds.tempDanger}°C)` });
      if ((prevSensors.temperature || 0) < CONFIG.thresholds.tempDanger) {
        addHistoryItem(`⚠ Seuil critique dépassé : ${temperature.toFixed(1)}°C`, 'temp');
      }
    } else if (temperature >= CONFIG.thresholds.tempWarn) {
      newAlerts.push({ type: 'warn', msg: `Température élevée : ${temperature.toFixed(1)}°C` });
    }
  }

  if (humidity !== null) {
    if (humidity >= CONFIG.thresholds.humDanger) {
      newAlerts.push({ type: 'danger', msg: `Humidité critique : ${humidity.toFixed(1)}% (seuil ${CONFIG.thresholds.humDanger}%)` });
    } else if (humidity >= CONFIG.thresholds.humWarn) {
      newAlerts.push({ type: 'warn', msg: `Humidité élevée : ${humidity.toFixed(1)}%` });
    }
  }

  APP_STATE.alerts = newAlerts;
  renderAlerts();
  updateGlobalStatus();
}

function renderAlerts() {
  const panel      = document.getElementById('alerts-panel');
  const emptyEl    = document.getElementById('alerts-empty');
  const badge      = document.getElementById('alert-count');
  if (!panel) return;

  Array.from(panel.querySelectorAll('.alert-item')).forEach(el => el.remove());

  if (APP_STATE.alerts.length === 0) {
    if (emptyEl) emptyEl.style.display = '';
    if (badge)   { badge.classList.remove('visible'); badge.textContent = ''; }
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  if (badge)   { badge.textContent = APP_STATE.alerts.length; badge.classList.add('visible'); }

  const iconW = `<svg style="width:15px;height:15px;flex-shrink:0;margin-top:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  const iconD = `<svg style="width:15px;height:15px;flex-shrink:0;margin-top:2px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

  APP_STATE.alerts.forEach(alert => {
    const el = document.createElement('div');
    el.className = `alert-item alert-item--${alert.type}`;
    el.innerHTML = (alert.type === 'danger' ? iconD : iconW) +
      `<span>${escapeHtml(alert.msg)}</span>`;
    panel.appendChild(el);
  });
}


/* ─────────────────────────────────────────────────────────────────
   8. HISTORIQUE
───────────────────────────────────────────────────────────────── */
function addHistoryItem(message, type = 'info') {
  const time = new Date().toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const item = { time, message, type };
  APP_STATE.history.unshift(item);
  if (APP_STATE.history.length > CONFIG.history.maxItems) APP_STATE.history.pop();

  renderHistoryItem(item, true);

  const emptyEl = document.getElementById('history-empty');
  if (emptyEl) emptyEl.style.display = 'none';
}

function renderHistoryItem(item, prepend = false) {
  const panel   = document.getElementById('history-panel');
  const emptyEl = document.getElementById('history-empty');
  if (!panel) return;

  const el = document.createElement('div');
  el.className = 'history-item';
  el.innerHTML = `
    <span class="history-time">${escapeHtml(item.time)}</span>
    <span class="history-msg">${escapeHtml(item.message)}</span>
  `;

  if (prepend) {
    panel.insertBefore(el, emptyEl ? emptyEl.nextSibling : panel.firstChild);
  } else {
    panel.appendChild(el);
  }
}


/* ─────────────────────────────────────────────────────────────────
   9. ÉTAT GLOBAL
───────────────────────────────────────────────────────────────── */
function updateGlobalStatus() {
  const badge = document.getElementById('global-status');
  const label = document.getElementById('global-status-label');
  if (!badge || !label) return;

  const dangers = APP_STATE.alerts.filter(a => a.type === 'danger').length;
  const warns   = APP_STATE.alerts.filter(a => a.type === 'warn').length;

  badge.className = 'hdr-pill hdr-pill--status';

  if (dangers > 0) {
    badge.classList.add('danger'); label.textContent = 'CRITIQUE';
  } else if (warns > 0) {
    badge.classList.add('warn');   label.textContent = 'ALERTE';
  } else if (APP_STATE.sensors.temperature !== null) {
    badge.classList.add('ok');     label.textContent = 'NOMINAL';
  } else {
    label.textContent = 'EN ATTENTE';
  }
}

function updateLastUpdateTime() {
  const el = document.getElementById('last-update-time');
  if (!el || !APP_STATE.sensors.lastUpdate) return;
  el.textContent = APP_STATE.sensors.lastUpdate.toLocaleTimeString('fr-FR');
}


/* ─────────────────────────────────────────────────────────────────
   10. COMMANDES (Écriture Firebase)
───────────────────────────────────────────────────────────────── */

/**
 * Envoie une commande actionneur vers Firebase.
 * Clés acceptées : 'lampe' | 'fan' | 'alim'
 * Guard : bloque en mode AUTO
 */
function sendCommand(actuator, value) {
  const db       = APP_STATE.firebase.db;
  const feedback = document.getElementById('cmd-feedback');

  if (APP_STATE.isAutoMode === true) {
    setFeedback(feedback, '🔒 Verrouillé — mode AUTO actif', 'warning');
    showToast('Mode AUTO — basculez en Manuel', 'warn');
    return;
  }

  if (!db) {
    simulateCommand(actuator, value);
    return;
  }

  setFeedback(feedback, '⏳ Envoi…', '');

  db.ref(`${DB_PATHS.actuators}/${actuator}`).set(value)
    .then(() => {
      setFeedback(feedback, `✓ ${labelOf(actuator)} → ${value ? 'ON' : 'OFF'}`, 'success');
      addHistoryItem(`Web → ${labelOf(actuator)} ${value ? 'ON' : 'OFF'}`, 'relay');
    })
    .catch(err => {
      console.error('[SIL]', err);
      setFeedback(feedback, '✗ Échec de l\'envoi', 'error');
      showToast('Erreur Firebase', 'danger');
    });
}

/**
 * [A] Envoie un changement de mode vers Firebase.
 * L'Arduino le lira dans la seconde qui suit.
 */
function sendModeCommand(isAuto) {
  const db = APP_STATE.firebase.db;

  if (!db) {
    // Mode démo : simuler localement
    APP_STATE.isAutoMode = isAuto; // Contourner le guard dans updateMode
    APP_STATE.isAutoMode = null;   // Forcer la ré-application
    updateMode(isAuto);
    addHistoryItem(`[Démo] Mode → ${isAuto ? 'AUTO' : 'MANUEL'}`, 'info');
    return;
  }

  db.ref(DB_PATHS.mode).set(isAuto)
    .then(() => {
      addHistoryItem(`Dashboard → Mode ${isAuto ? 'AUTO' : 'MANUEL'} envoyé`, 'info');
      // updateMode sera appelé par le listener Firebase
    })
    .catch(err => {
      console.error('[SIL] Erreur changement de mode:', err);
      showToast('Erreur changement de mode', 'danger');
    });
}

/**
 * [B] Simulation locale (mode démo) — avec mapping correct des clés
 */
function simulateCommand(actuator, value) {
  if (APP_STATE.isAutoMode === true) {
    const feedback = document.getElementById('cmd-feedback');
    setFeedback(feedback, '🔒 Verrouillé — mode AUTO', 'warning');
    return;
  }

  // Mapping clé Firebase → clé du state JS
  const stateKey = { alim: 'power', fan: 'fan', lampe: 'lamp' };
  const key = stateKey[actuator] || actuator;
  APP_STATE.actuators[key] = value;

  renderActuatorItems();
  syncCmdButtons();

  const msg = `[Démo] ${labelOf(actuator)} ${value ? 'ON' : 'OFF'}`;
  addHistoryItem(msg, 'relay');
  showToast(msg, 'ok');

  const feedback = document.getElementById('cmd-feedback');
  setFeedback(feedback, '[Démo] Appliqué localement', 'warning');
  updateGlobalStatus();
}

/* ── Listeners boutons ── */
function attachCommandListeners() {
  // Lampe
  el('btn-lampe-on') ?.addEventListener('click', () => sendCommand('lampe', true));
  el('btn-lampe-off')?.addEventListener('click', () => sendCommand('lampe', false));

  // Ventilateur
  el('btn-fan-on') ?.addEventListener('click', () => sendCommand('fan', true));
  el('btn-fan-off')?.addEventListener('click', () => sendCommand('fan', false));

  // Alimentation (confirm avant coupure)
  el('btn-power-toggle')?.addEventListener('click', () => {
    const current = APP_STATE.actuators.power;
    if (current === true) {
      if (confirm('⚠ Couper l\'alimentation externe ?')) sendCommand('alim', false);
    } else {
      sendCommand('alim', true);
    }
  });

  // [A] Mode switch
  el('btn-mode-auto')  ?.addEventListener('click', () => {
    if (APP_STATE.isAutoMode !== true) sendModeCommand(true);
  });
  el('btn-mode-manual')?.addEventListener('click', () => {
    if (APP_STATE.isAutoMode !== false) sendModeCommand(false);
  });

  // Thème
  el('theme-toggle')?.addEventListener('click', toggleTheme);

  // Effacer historique
  el('btn-clear-history')?.addEventListener('click', () => {
    APP_STATE.history = [];
    Array.from(document.querySelectorAll('#history-panel .history-item'))
      .forEach(e => e.remove());
    const emptyEl = document.getElementById('history-empty');
    if (emptyEl) emptyEl.style.display = '';
    showToast('Historique effacé', 'info');
  });
}

/* ── Helpers ── */
function el(id) { return document.getElementById(id); }

function labelOf(act) {
  return { lampe: 'Lampe', fan: 'Ventilateur', alim: 'Alimentation' }[act] || act;
}

function setFeedback(el, msg, cls) {
  if (!el) return;
  el.textContent = msg;
  el.className   = 'cmd-feedback' + (cls ? ` ${cls}` : '');
  el.classList.add('visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('visible'), 3500);
}


/* ─────────────────────────────────────────────────────────────────
   11. UTILITAIRES
───────────────────────────────────────────────────────────────── */
function setFirebaseStatus(connected, customLabel = null) {
  const badge = document.getElementById('firebase-status');
  const label = document.getElementById('firebase-label');
  if (!badge || !label) return;

  badge.classList.remove('connected', 'disconnected');
  badge.classList.add(connected ? 'connected' : 'disconnected');
  label.textContent = customLabel ?? (connected ? 'Firebase connecté' : 'Déconnecté');
}

function showToast(message, type = 'ok', duration = 3200) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast ${type} show`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function startClock() {
  const clockEl = document.getElementById('clock');
  if (!clockEl) return;
  const tick = () => {
    clockEl.textContent = new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };
  tick();
  setInterval(tick, 1000);

  const yearEl = document.getElementById('footer-year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(String(text)));
  return d.innerHTML;
}

function initTheme() {
  if (localStorage.getItem('sil-theme') === 'light') {
    document.body.classList.add('light-mode');
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('sil-theme', isLight ? 'light' : 'dark');
}


/* ─────────────────────────────────────────────────────────────────
   12. MODE DÉMO (données simulées)
───────────────────────────────────────────────────────────────── */
let demoTick = 0;

function startDemoMode() {
  addHistoryItem('Mode Démo — Firebase non connecté', 'info');
  generateDemoData();

  setInterval(() => {
    generateDemoData();
    demoTick++;
    if (demoTick % 8 === 0) {
      const temp  = APP_STATE.sensors.temperature;
      const fanOn = temp !== null && temp > CONFIG.thresholds.tempWarn;
      if (fanOn !== APP_STATE.actuators.fan) {
        APP_STATE.actuators.fan = fanOn;
        renderActuatorItems();
        syncCmdButtons();
      }
    }
  }, CONFIG.chart.intervalMs);

  // Démo démarre en mode MANUEL
  APP_STATE.isAutoMode = null; // Forcer l'application
  updateMode(false);
}

function generateDemoData() {
  const t = demoTick;
  const baseTemp = 26 + Math.sin(t * 0.3) * 4 + Math.random() * 1.5;
  const hum      = 55 + Math.sin(t * 0.2 + 1) * 10 + Math.random() * 2;
  const light    = Math.max(0, 320 + Math.sin(t * 0.1) * 150 + Math.random() * 30);

  // [FIX demo] Clés correctes : temp / hum / lux
  updateSensors({
    temp: parseFloat(baseTemp.toFixed(1)),
    hum:  parseFloat(hum.toFixed(1)),
    lux:  Math.round(light)
  });

  if (APP_STATE.actuators.fan === null) {
    updateActuators({ fan: false, alim: true, lampe: false });
  }
}


/* ─────────────────────────────────────────────────────────────────
   13. BOOTSTRAP
───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  startClock();
  initChart();
  attachCommandListeners();
  initFirebase();
  addHistoryItem('Dashboard SIL démarré', 'info');
  console.log('[SIL] v8.0 — Sentinelle Intelligente de Laboratoire initialisée.');
});
