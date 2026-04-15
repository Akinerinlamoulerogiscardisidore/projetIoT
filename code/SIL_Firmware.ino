/*
 * ═══════════════════════════════════════════════════════════════
 *  PROJET  : Sentinelle Intelligente de Laboratoire (SIL)
 *  VERSION : 9.0 — Architecture Maître-Esclave
 *  Auteur  : Giscard / UNSTIM-INSTI
 * ═══════════════════════════════════════════════════════════════
 *
 *  PRINCIPE FONDAMENTAL v9.0
 *  ─────────────────────────
 *  L'Arduino n'est plus un décideur. Il est un EXÉCUTANT PUR.
 *
 *  CE QUE FAIT L'ARDUINO :
 *  ✔ Lit les capteurs en continu (temp, hum, pres, lux, iaq, co2)
 *  ✔ Écrit UNIQUEMENT les données environnementales dans Firebase
 *  ✔ Lit les ordres de commande dans Firebase
 *  ✔ Applique ces ordres au matériel physique immédiatement
 *  ✔ Animations LED de statut (WiFi, mode)
 *
 *  CE QUE NE FAIT PLUS L'ARDUINO :
 *  ✗ Aucune logique d'automatisme (seuil, hystérésis)
 *  ✗ Aucune écriture des états actionneurs (fan, lampe, alim)
 *  ✗ Aucune gestion des touches tactiles
 *  ✗ Aucune décision autonome d'allumer ou d'éteindre
 *
 *  FLUX DE DONNÉES FIREBASE (séparation stricte, sans conflit)
 *  ───────────────────────────────────────────────────────────
 *  ARDUINO  ÉCRIT  → SIL/telemetrie/{temp,hum,pres,lux,iaq,co2}
 *  ARDUINO  LIT    ← SIL/etat/{lampe,alim,fan}
 *  ARDUINO  LIT    ← SIL/mode_auto
 *
 *  DASHBOARD ÉCRIT → SIL/etat/{lampe,alim,fan}
 *  DASHBOARD ÉCRIT → SIL/mode_auto
 *  DASHBOARD LIT   ← SIL/telemetrie/*
 *
 *  → Aucun chemin n'est écrit par les deux parties simultanément.
 *
 *  NOUVEAUX CAPTEURS (BME688 via Arduino_MKRIoTCarrier)
 *  ─────────────────────────────────────────────────────
 *  · Pression        : carrier.Env.readPressure()         → hPa
 *  · IAQ statique    : carrier.AirQuality.readStaticIAQ() → 0-500
 *  · CO2 équivalent  : carrier.AirQuality.readCO2()       → ppm
 *
 *  FIABILITÉ — 3 objets FirebaseData séparés
 *  ──────────────────────────────────────────
 *  fbTelemetrie : écriture capteurs (jamais bloqué par une lecture)
 *  fbCommande   : lecture actionneurs (jamais bloqué par une écriture)
 *  fbMode       : lecture mode (cycle lent, objet dédié)
 *
 *  TIMINGS
 *  ───────
 *  Commandes (polling)   : 500 ms → réactivité maximale aux clics Web
 *  Télémétrie (upload)   : 5 s   → données fraîches pour logique AUTO
 *  Mode (polling)        : 2 s   → synchronisation LED légère
 * ═══════════════════════════════════════════════════════════════
 */

#include <WiFiNINA.h>
#include <Arduino_MKRIoTCarrier.h>
#include <Firebase_Arduino_WiFiNINA.h>

// ─── Identifiants réseau & Firebase ──────────────────────────
const char SSID_WIFI[] = "AAAA";           // ← Remplacer par ton SSID
const char PASS_WIFI[] = "12345678";       // ← Remplacer par ton mot de passe
#define FIREBASE_HOST "sentinelle-sil-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "flJNlL3QVcc1luvO7l1F0EwpTKPb8HBz0Fse2g9v"

// ─── Intervalles de cycle (ms) ────────────────────────────────
const unsigned long INTERVAL_CMD       = 500;   // Polling commandes
const unsigned long INTERVAL_TELEMETRY = 5000;  // Envoi télémétrie
const unsigned long INTERVAL_MODE      = 2000;  // Lecture mode

// ─── Objets matériels ────────────────────────────────────────
MKRIoTCarrier carrier;

// ─── Objets Firebase (isolation fonctionnelle) ───────────────
FirebaseData fbTelemetrie;  // ÉCRITURE capteurs uniquement
FirebaseData fbCommande;    // LECTURE commandes actionneurs uniquement
FirebaseData fbMode;        // LECTURE mode AUTO/MANUEL uniquement

// ─── Miroir local des ordres Firebase ────────────────────────
bool etatLampe       = false;
bool etatAlimExterne = false;
bool etatVentilateur = false;
bool isAutoMode      = true;  // Initialisé depuis Firebase au démarrage

// ─── Valeurs capteurs ─────────────────────────────────────────
float tAct   = 0.0;   // Température (°C)
float hAct   = 0.0;   // Humidité (%)
float pAct   = 0.0;   // Pression atmosphérique (hPa)
int   lAct   = 0;     // Luminosité (valeur 0-255)
float iaqAct = 0.0;   // Indice qualité de l'air (0-500, static IAQ)
float co2Act = 0.0;   // CO₂ équivalent (ppm)

// ─── Timers millis() ──────────────────────────────────────────
unsigned long lastCmd       = 0;
unsigned long lastTelemetry = 0;
unsigned long lastMode      = 0;


/* ═══════════════════════════════════════════════════════════════
   ANIMATIONS LED
   Statut de connexion WiFi visible physiquement.
   ═══════════════════════════════════════════════════════════════ */

// Jaune clignotant non-bloquant pendant l'attente WiFi
void animerAttente() {
  static unsigned long tBlink = 0;
  static bool          ledOn  = false;

  if (millis() - tBlink >= 400) {
    tBlink = millis();
    ledOn  = !ledOn;
    uint32_t col = ledOn ? carrier.leds.Color(220, 150, 0) : 0;
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, col);
    carrier.leds.show();
  }
}

// Trois clignotements verts rapides = WiFi connecté
void animerConnecte() {
  for (int k = 0; k < 3; k++) {
    for (int i = 0; i < 5; i++)
      carrier.leds.setPixelColor(i, carrier.leds.Color(0, 220, 0));
    carrier.leds.show();
    delay(160);
    for (int i = 0; i < 5; i++)
      carrier.leds.setPixelColor(i, 0);
    carrier.leds.show();
    delay(160);
  }
}


/* ═══════════════════════════════════════════════════════════════
   LECTURE CAPTEURS
   Tous les capteurs disponibles sur le MKR IoT Carrier.
   Appelée avant chaque envoi télémétrie.
   ═══════════════════════════════════════════════════════════════ */

void lireCapteurs() {
  // Température (°C) — BME688
  float t = carrier.Env.readTemperature();
  if (!isnan(t)) tAct = t;

  // Humidité (%) — BME688
  float h = carrier.Env.readHumidity();
  if (!isnan(h)) hAct = h;

  // Pression atmosphérique (hPa) — BME688
  // Garde-fou : valeur hors de la plage physique réaliste ignorée
  float p = carrier.Pressure.readPressure();
  if (!isnan(p) && p > 800.0 && p < 1200.0) pAct = p;

  // Luminosité (APDS9960) — approximation via RGB
  if (carrier.Light.colorAvailable()) {
    int r, g, b;
    carrier.Light.readColor(r, g, b);
    lAct = (r + g + b) / 3;
  }

  // Indice de qualité de l'air IAQ statique (BME688 BSEC)
  // readStaticIAQ() : stable dès le démarrage, pas de calibration requise
  // Échelle : 0-50 Excellent · 51-100 Bon · 101-150 Modéré · >150 Mauvais
  float iaq = carrier.AirQuality.readStaticIAQ();
  if (!isnan(iaq) && iaq >= 0.0) iaqAct = iaq;

  // CO₂ équivalent (ppm) — BME688 BSEC
  // Normal intérieur : 400-1000 ppm · Préoccupant : >2000 ppm
  float co2 = carrier.AirQuality.readCO2();
  if (!isnan(co2) && co2 > 0.0) co2Act = co2;
}


/* ═══════════════════════════════════════════════════════════════
   ENVOI TÉLÉMÉTRIE → Firebase
   L'Arduino est le SEUL scripteur sur SIL/telemetrie/*.
   Le Dashboard et la logique AUTO du Dashboard lisent ces valeurs.
   ═══════════════════════════════════════════════════════════════ */

void envoyerTelemetrie() {
  Firebase.setFloat(fbTelemetrie, "SIL/telemetrie/temp", tAct);
  Firebase.setFloat(fbTelemetrie, "SIL/telemetrie/hum",  hAct);
  Firebase.setFloat(fbTelemetrie, "SIL/telemetrie/pres", pAct);
  Firebase.setInt  (fbTelemetrie, "SIL/telemetrie/lux",  lAct);
  Firebase.setFloat(fbTelemetrie, "SIL/telemetrie/iaq",  iaqAct);
  Firebase.setFloat(fbTelemetrie, "SIL/telemetrie/co2",  co2Act);

  // Log série pour debug
  Serial.print("[TELEM] T:");   Serial.print(tAct, 1);
  Serial.print(" H:");          Serial.print(hAct, 1);
  Serial.print(" P:");          Serial.print(pAct, 1);
  Serial.print(" L:");          Serial.print(lAct);
  Serial.print(" IAQ:");        Serial.print(iaqAct, 1);
  Serial.print(" CO2:");        Serial.println(co2Act, 1);
}


/* ═══════════════════════════════════════════════════════════════
   LECTURE & APPLICATION DES COMMANDES ← Firebase
   Le Dashboard est le SEUL scripteur sur SIL/etat/*.
   L'Arduino lit et applique strictement, sans décision propre.
   ═══════════════════════════════════════════════════════════════ */

void lireEtAppliquerCommandes() {
  bool changed = false;

  // Lampe ─────────────────────────────────────────────────────
  if (Firebase.getBool(fbCommande, "SIL/etat/lampe")) {
    bool v = fbCommande.boolData();
    if (v != etatLampe) {
      etatLampe = v;
      changed   = true;
      Serial.print("[CMD] lampe → "); Serial.println(etatLampe ? "ON" : "OFF");
    }
  }

  // Alimentation externe ──────────────────────────────────────
  if (Firebase.getBool(fbCommande, "SIL/etat/alim")) {
    bool v = fbCommande.boolData();
    if (v != etatAlimExterne) {
      etatAlimExterne = v;
      changed         = true;
      Serial.print("[CMD] alim  → "); Serial.println(etatAlimExterne ? "ON" : "OFF");
    }
  }

  // Ventilateur ───────────────────────────────────────────────
  // NB : cet ordre peut venir d'un clic manuel OU de la logique
  // AUTO du Dashboard (seuil température dépassé). L'Arduino
  // ne fait aucune distinction — il exécute dans tous les cas.
  if (Firebase.getBool(fbCommande, "SIL/etat/fan")) {
    bool v = fbCommande.boolData();
    if (v != etatVentilateur) {
      etatVentilateur = v;
      changed         = true;
      Serial.print("[CMD] fan   → "); Serial.println(etatVentilateur ? "ON" : "OFF");
    }
  }

  // Appliquer physiquement si au moins un état a changé
  if (changed) appliquerHardware();
}


/* ═══════════════════════════════════════════════════════════════
   LECTURE MODE ← Firebase
   Synchronise l'indicateur LED avec le mode défini dans le Cloud.
   ═══════════════════════════════════════════════════════════════ */

void lireMode() {
  if (Firebase.getBool(fbMode, "SIL/mode_auto")) {
    bool webMode = fbMode.boolData();
    if (webMode != isAutoMode) {
      isAutoMode = webMode;
      Serial.print("[MODE] → "); Serial.println(isAutoMode ? "AUTO" : "MANUEL");
      appliquerHardware(); // Mise à jour LED indicateur
    }
  }
}


/* ═══════════════════════════════════════════════════════════════
   APPLICATION HARDWARE
   Seul endroit où le matériel physique est commandé.
   Appelé uniquement si un ordre Firebase a changé.
   ═══════════════════════════════════════════════════════════════ */

void appliquerHardware() {
  // Relais 1 : Alimentation externe
  if (etatAlimExterne) carrier.Relay1.close(); else carrier.Relay1.open();

  // Relais 2 : Ventilateur
  if (etatVentilateur) carrier.Relay2.close(); else carrier.Relay2.open();

  // LEDs 0-3 : Lampe — blanc chaud si ON
  uint32_t cLampe = etatLampe ? carrier.leds.Color(180, 160, 80) : 0;
  for (int i = 0; i < 4; i++) carrier.leds.setPixelColor(i, cLampe);

  // LED 4 : Indicateur de mode
  //   Bleu   (0,0,200)   = AUTO   — Dashboard en automatique
  //   Violet (200,0,200) = MANUEL — Opérateur aux commandes
  if (isAutoMode)
    carrier.leds.setPixelColor(4, carrier.leds.Color(0,   0,   200));
  else
    carrier.leds.setPixelColor(4, carrier.leds.Color(200, 0,   200));

  carrier.leds.show();
}


/* ═══════════════════════════════════════════════════════════════
   SETUP
   ═══════════════════════════════════════════════════════════════ */

void setup() {
  Serial.begin(115200);
  Serial.println("\n[SIL] Démarrage v9.0 — Architecture Maître-Esclave");

  // ── Initialisation du MKR IoT Carrier ───────────────────────
  CARRIER_CASE = false;
  if (!carrier.begin()) {
    Serial.println("[ERR] Carrier non initialisé");
  }
  carrier.leds.setBrightness(50);

  // ── Connexion WiFi avec animation LED jaune ──────────────────
  Serial.print("[WiFi] Connexion à '");
  Serial.print(SSID_WIFI); Serial.print("'");
  WiFi.begin(SSID_WIFI, PASS_WIFI);

  while (WiFi.status() != WL_CONNECTED) {
    animerAttente();
    delay(50);
    Serial.print(".");
  }
  Serial.println(" OK");
  Serial.print("[WiFi] IP : "); Serial.println(WiFi.localIP());

  // ── Animation succès : vert x3 ──────────────────────────────
  animerConnecte();

  // ── Firebase ─────────────────────────────────────────────────
  Firebase.begin(FIREBASE_HOST, FIREBASE_AUTH, SSID_WIFI, PASS_WIFI);
  Firebase.reconnectWiFi(true);
  Serial.println("[Firebase] Connecté");

  // ── Lecture du mode initial depuis le Cloud ──────────────────
  if (Firebase.getBool(fbMode, "SIL/mode_auto")) {
    isAutoMode = fbMode.boolData();
  }
  Serial.print("[MODE] Démarrage en mode : ");
  Serial.println(isAutoMode ? "AUTO" : "MANUEL");

  // ── Lecture des commandes initiales ─────────────────────────
  lireEtAppliquerCommandes();

  // ── Premier relevé capteurs ──────────────────────────────────
  lireCapteurs();
  appliquerHardware();

  Serial.println("[SIL] Prêt — en attente des ordres Firebase.\n");
}


/* ═══════════════════════════════════════════════════════════════
   LOOP PRINCIPAL
   Trois cycles indépendants, non-bloquants (millis).
   ═══════════════════════════════════════════════════════════════ */

void loop() {
  unsigned long now = millis();

  // ─── CYCLE A : Commandes (500 ms) ────────────────────────────
  // Priorité maximale. Lit SIL/etat/* et applique si changement.
  // La fréquence de 500 ms garantit < 1 s de latence perçue.
  if (now - lastCmd >= INTERVAL_CMD) {
    lastCmd = now;
    lireEtAppliquerCommandes();
  }

  // ─── CYCLE B : Télémétrie (5 s) ──────────────────────────────
  // Lit tous les capteurs et publie dans SIL/telemetrie/*.
  // Le Dashboard (logique AUTO) déclenche le fan si T° > seuil.
  if (now - lastTelemetry >= INTERVAL_TELEMETRY) {
    lastTelemetry = now;
    lireCapteurs();
    envoyerTelemetrie();
  }

  // ─── CYCLE C : Mode (2 s) ────────────────────────────────────
  // Lit SIL/mode_auto pour synchroniser l'indicateur LED.
  if (now - lastMode >= INTERVAL_MODE) {
    lastMode = now;
    lireMode();
  }
}
