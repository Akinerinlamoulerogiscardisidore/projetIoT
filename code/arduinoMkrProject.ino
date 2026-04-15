/*
 * ═══════════════════════════════════════════════════════════════
 *  PROJET  : Sentinelle Intelligente de Laboratoire (SIL)
 *  VERSION : 9.1 — Réactivité Optimisée
 * ═══════════════════════════════════════════════════════════════
 *  CORRECTIFS v9.1
 *  ✓ Télémétrie compressée en 1 seul paquet JSON (7 req → 1)
 *  ✓ Deux objets FirebaseData séparés (commande / télémétrie)
 *    pour éviter les conflits de buffer
 * ═══════════════════════════════════════════════════════════════
 */

#include <WiFiNINA.h>
#include <Arduino_MKRIoTCarrier.h>
#include <Firebase_Arduino_WiFiNINA.h>

// ── Credentials ──────────────────────────────────────────────
const char SSID_WIFI[] = "AAAA";
const char PASS_WIFI[] = "12345678";
#define FIREBASE_HOST "sentinelle-sil-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "flJNlL3QVcc1luvO7l1F0EwpTKPb8HBz0Fse2g9v"

// ── Intervalles ───────────────────────────────────────────────
const unsigned long INTERVAL_CMD   = 500;
const unsigned long INTERVAL_TELEM = 5000;

// ── Instances ────────────────────────────────────────────────
MKRIoTCarrier carrier;

// ✅ CORRECTIF 1 : Deux objets séparés pour éviter les conflits
FirebaseData fbCommande;    // Dédié à la LECTURE des ordres (Bloc 1)
FirebaseData fbTelemetrie;  // Dédié à l'ÉCRITURE capteurs  (Bloc 2)

// ── État actionneurs ──────────────────────────────────────────
bool isAutoMode      = true;
bool etatLampe       = false;
bool etatAlimExterne = false;
bool etatVentilateur = false;

// ── Données capteurs ─────────────────────────────────────────
float tAct   = 0.0;
float hAct   = 0.0;
int   lAct   = 0;
float pAct   = 0.0;
float iaqAct = 0.0;
float co2Act = 0.0;
int   iaqAcc = 0;

unsigned long lastCmd = 0, lastTelem = 0;


/* ─── LED : connexion WiFi ──────────────────────────────────── */

void animerAttente() {
  static unsigned long t0 = 0;
  static bool          on = false;
  if (millis() - t0 >= 400) {
    t0 = millis(); on = !on;
    uint32_t c = on ? carrier.leds.Color(220, 150, 0) : 0;
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, c);
    carrier.leds.show();
  }
}

void animerConnecte() {
  for (int k = 0; k < 3; k++) {
    for (int i = 0; i < 5; i++)
      carrier.leds.setPixelColor(i, carrier.leds.Color(0, 220, 0));
    carrier.leds.show(); delay(180);
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, 0);
    carrier.leds.show(); delay(180);
  }
}


/* ─── Setup ─────────────────────────────────────────────────── */

void setup() {
  Serial.begin(115200);
  CARRIER_CASE = true;
  if (!carrier.begin()) Serial.println("[ERR] Carrier non initialisé");
  carrier.leds.setBrightness(45);

  Serial.print("[WiFi] Connexion");
  WiFi.begin(SSID_WIFI, PASS_WIFI);
  while (WiFi.status() != WL_CONNECTED) {
    animerAttente();
    Serial.print(".");
  }
  Serial.print(" OK — "); Serial.println(WiFi.localIP());

  animerConnecte();

  Firebase.begin(FIREBASE_HOST, FIREBASE_AUTH, SSID_WIFI, PASS_WIFI);
  Firebase.reconnectWiFi(true);
  Serial.println("[Firebase] OK");

  updateHardware();
}


/* ─── Loop ──────────────────────────────────────────────────── */

void loop() {
  unsigned long now = millis();

  /* ═══════════════════════════════════════════════════════════
     BLOC 1 — LECTURE DES ORDRES (500 ms)
     Utilise fbCommande — jamais bloqué par la télémétrie
     ═══════════════════════════════════════════════════════════ */
  if (now - lastCmd >= INTERVAL_CMD) {
    lastCmd = now;
    bool changed = false;

    // ✅ CORRECTIF 2 : fbCommande au lieu de fbData
    if (Firebase.getBool(fbCommande, "SIL/mode_auto")) {
      bool v = fbCommande.boolData();
      if (v != isAutoMode) {
        isAutoMode = v; changed = true;
        Serial.println(v ? "[MODE] AUTO" : "[MODE] MANUEL");
      }
    }

    if (Firebase.getBool(fbCommande, "SIL/etat/lampe")) {
      bool v = fbCommande.boolData();
      if (v != etatLampe) { etatLampe = v; changed = true; }
    }

    if (Firebase.getBool(fbCommande, "SIL/etat/alim")) {
      bool v = fbCommande.boolData();
      if (v != etatAlimExterne) { etatAlimExterne = v; changed = true; }
    }

    if (Firebase.getBool(fbCommande, "SIL/etat/fan")) {
      bool v = fbCommande.boolData();
      if (v != etatVentilateur) { etatVentilateur = v; changed = true; }
    }

    if (changed) updateHardware();
  }


  /* ═══════════════════════════════════════════════════════════
     BLOC 2 — LECTURE CAPTEURS + TÉLÉMÉTRIE (5 s)
     ✅ CORRECTIF 3 : 1 seul paquet JSON au lieu de 7 requêtes
     Utilise fbTelemetrie — indépendant du Bloc 1
     ═══════════════════════════════════════════════════════════ */
  if (now - lastTelem >= INTERVAL_TELEM) {
    lastTelem = now;

    // HTS221 — Température / Humidité
    float t = carrier.Env.readTemperature();
    if (!isnan(t)) tAct = t;
    float h = carrier.Env.readHumidity();
    if (!isnan(h)) hAct = h;

    // APDS9960 — Luminosité
    if (carrier.Light.colorAvailable()) {
      int r, g, b;
      carrier.Light.readColor(r, g, b);
      lAct = (r + g + b) / 3;
    }

    // BME688 — Pression, IAQ, CO₂
    float p = carrier.Pressure.readPressure();
    if (!isnan(p) && p > 0) pAct = p;

    float iaq = carrier.AirQuality.readStaticIAQ();
    if (!isnan(iaq) && iaq >= 0) iaqAct = iaq;

    float co2 = carrier.AirQuality.readCO2();
    if (!isnan(co2) && co2 > 0) co2Act = co2;

    iaqAcc = (int)carrier.AirQuality.readIAQAccuracy();

    // ✅ CORRECTIF 3 : Construction manuelle de la chaîne JSON (Format String)
    // On concatène pour obtenir : {"temp":25.5,"hum":60.0,...}
    String jsonTelemetrie = "{";
    jsonTelemetrie += "\"temp\":" + String(tAct) + ",";
    jsonTelemetrie += "\"hum\":" + String(hAct) + ",";
    jsonTelemetrie += "\"lux\":" + String(lAct) + ",";
    jsonTelemetrie += "\"pression\":" + String(pAct) + ",";
    jsonTelemetrie += "\"iaq\":" + String(iaqAct) + ",";
    jsonTelemetrie += "\"co2\":" + String(co2Act) + ",";
    jsonTelemetrie += "\"iaqAcc\":" + String(iaqAcc);
    jsonTelemetrie += "}";

    // 1 SEULE requête HTTP au lieu de 7, en utilisant la chaîne JSON formatée
    if (Firebase.setJSON(fbTelemetrie, "SIL/telemetrie", jsonTelemetrie)) {
      Serial.print("[TELEM] T:"); Serial.print(tAct);
      Serial.print(" H:");        Serial.print(hAct);
      Serial.print(" Lux:");      Serial.print(lAct);
      Serial.print(" P:");        Serial.print(pAct);
      Serial.print("hPa IAQ:");   Serial.print(iaqAct);
      Serial.print("(");          Serial.print(iaqAcc);
      Serial.print(") CO2:");     Serial.print(co2Act);
      Serial.println("ppm — JSON OK");
    } else {
      Serial.print("[ERR] Télémétrie : ");
      Serial.println(fbTelemetrie.errorReason());
    }
  }
}


/* ─── updateHardware ────────────────────────────────────────── */

void updateHardware() {
  if (etatAlimExterne) carrier.Relay1.close(); else carrier.Relay1.open();
  if (etatVentilateur) carrier.Relay2.close(); else carrier.Relay2.open();

  uint32_t c = etatLampe ? carrier.leds.Color(200, 170, 90) : 0;
  for (int i = 0; i < 4; i++) carrier.leds.setPixelColor(i, c);

  carrier.leds.setPixelColor(4,
    isAutoMode ? carrier.leds.Color(0, 0, 210)
               : carrier.leds.Color(200, 0, 210)
  );

  carrier.leds.show();
}