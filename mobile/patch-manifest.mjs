// Inserta los permisos de ubicación en segundo plano en el AndroidManifest.xml
// generado por Capacitor (se ejecuta en CI tras `npx cap add android`).
import { readFileSync, writeFileSync, existsSync } from "fs";

const path = "android/app/src/main/AndroidManifest.xml";
if (!existsSync(path)) {
  console.error("No se encontro AndroidManifest.xml");
  process.exit(1);
}

let xml = readFileSync(path, "utf8");

const perms = [
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_LOCATION",
  "android.permission.WAKE_LOCK",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
];

const toAdd = perms
  .filter((p) => !xml.includes(`"${p}"`))
  .map((p) => `    <uses-permission android:name="${p}" />`)
  .join("\n");

if (toAdd) {
  xml = xml.replace(/<manifest([^>]*)>/, `<manifest$1>\n${toAdd}`);
  writeFileSync(path, xml);
  console.log("Permisos de ubicacion agregados al manifest.");
} else {
  console.log("Los permisos ya estaban presentes.");
}
