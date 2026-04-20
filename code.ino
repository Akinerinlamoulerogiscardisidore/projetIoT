
#include <WiFiNINA.h>
#include <Arduino_MKRIoTCarrier.h>
#include <Firebase_Arduino_WiFiNINA.h>

// Configuration du réseau et de la Base de données 
const char SSID_WIFI[] = "TCL-394C"; 
const char PASS_WIFI[] = "Hurq93F76td9";
#define FIREBASE_HOST "sentinelle-sil-default-rtdb.firebaseio.com"
#define FIREBASE_AUTH "flJNlL3QVcc1luvO7l1F0EwpTKPb8HBz0Fse2g9v"

// Paramètres de synchronisation
const unsigned long INTERVAL_TELEM = 3000; // Envoi des infos toutes les 3 secondes
unsigned long lastTelem = 0;

// Instances
MKRIoTCarrier carrier;
FirebaseData fbTelemetrie;

// Variables de stockage des données 
float tAct = 0.0, hAct = 0.0, pAct = 0.0;
float iaqAct = 0.0, co2Act = 0.0;
int lAct = 0, iaqAcc = 0;

// ANIMATIONS DE DIAGNOSTIC 

// Orange clignotant pendant la recherche du hotspot WiFi
void animerAttente() {
  static unsigned long t0 = 0; static bool on = false;
  if (millis() - t0 >= 400) {
    t0 = millis(); on = !on;
    uint32_t c = on ? carrier.leds.Color(220, 150, 0) : 0;
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, c);
    carrier.leds.show();
  }
}

// Triple flash de couleur verte lors de la connexion réussie
void animerConnecte() {
  for (int k = 0; k < 3; k++) {
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, carrier.leds.Color(0, 220, 0));
    carrier.leds.show(); delay(150);
    for (int i = 0; i < 5; i++) carrier.leds.setPixelColor(i, 0);
    carrier.leds.show(); delay(150);
  }
}

// SETUP
void setup() {
  Serial.begin(115200);
  CARRIER_CASE = false; 

  if (!carrier.begin()) {
    Serial.println(" Échec d'initialisation du carrier");
    while(1); 
  }
  
  carrier.leds.setBrightness(30); // Réglage de la luminosité des LEDs

  Serial.print("Connexion WiFi...");
  WiFi.begin(SSID_WIFI, PASS_WIFI);
  while (WiFi.status() != WL_CONNECTED) {
    animerAttente();
    Serial.print(".");
  }
  Serial.println(" Connecté !");

  animerConnecte();

  // Initialisation de la liaison Firebase
  Firebase.begin(FIREBASE_HOST, FIREBASE_AUTH, SSID_WIFI, PASS_WIFI);
  Firebase.reconnectWiFi(true);
}

// LOOP PRINCIPAL
void loop() {
  unsigned long now = millis();

  // Cycle de télémétrie (toutes les 3 secondes)
  if (now - lastTelem >= INTERVAL_TELEM) {
    lastTelem = now;

    // 1. Lecture des capteurs environnementaux
    float t = carrier.Env.readTemperature(); if (!isnan(t)) tAct = t;
    float h = carrier.Env.readHumidity();    if (!isnan(h)) hAct = h;
    float p = carrier.Pressure.readPressure(); if (!isnan(p)) pAct = p;
    
    // 2. Lecture de la luminosité ambiante
    if (carrier.Light.colorAvailable()) {
      int r, g, b; carrier.Light.readColor(r, g, b);
      lAct = (r + g + b) / 3;
    }

    // 3. Lecture de la qualité de l'Air
    float iaq = carrier.AirQuality.readStaticIAQ(); if (!isnan(iaq)) iaqAct = iaq;
    float co2 = carrier.AirQuality.readCO2(); if (!isnan(co2)) co2Act = co2;
    iaqAcc = (int)carrier.AirQuality.readIAQAccuracy();

    // 4. Construction du JSON pour le Dashboard
    String json = "{";
    json += "\"temp\":" + String(tAct) + ",";
    json += "\"hum\":" + String(hAct) + ",";
    json += "\"lux\":" + String(lAct) + ",";
    json += "\"pression\":" + String(pAct) + ",";
    json += "\"iaq\":" + String(iaqAct) + ",";
    json += "\"co2\":" + String(co2Act) + ",";
    json += "\"iaqAcc\":" + String(iaqAcc);
    json += "}";

    // 5. Envoi vers Firebase et animation de confirmation
    if (Firebase.setJSON(fbTelemetrie, "SIL/telemetrie", json)) {
      Serial.println("[OK] Dashboard mis à jour."); 
      
      // Flash des 5 LEDs (Couleur Cyan/Turquoise : 0, 255, 200)
      for (int i = 0; i < 5; i++) {
        carrier.leds.setPixelColor(i, carrier.leds.Color(0, 255, 200));
      }
      carrier.leds.show();

      delay(100); // Durée du flash visible

      // Extinction des LEDs
      for (int i = 0; i < 5; i++) {
        carrier.leds.setPixelColor(i, 0);
      }
      carrier.leds.show();
    } else {
      Serial.print("[ERR] Firebase: ");
      Serial.println(fbTelemetrie.errorReason());
    }
  }
}
