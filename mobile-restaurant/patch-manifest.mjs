// Registra la app como destino de "Compartir" (texto) desde otras apps (WhatsApp).
import { readFileSync, writeFileSync, existsSync } from "fs";

const path = "android/app/src/main/AndroidManifest.xml";
if (!existsSync(path)) {
  console.error("No se encontro AndroidManifest.xml");
  process.exit(1);
}
let xml = readFileSync(path, "utf8");

if (!xml.includes("android.intent.action.SEND")) {
  const filter =
    '            <intent-filter>\n' +
    '                <action android:name="android.intent.action.SEND" />\n' +
    '                <category android:name="android.intent.category.DEFAULT" />\n' +
    '                <data android:mimeType="text/plain" />\n' +
    '            </intent-filter>\n' +
    "        </activity>";
  // Inserta el filtro dentro de la MainActivity (primer </activity>)
  xml = xml.replace("</activity>", filter);
  writeFileSync(path, xml);
  console.log("Intent de compartir (SEND) agregado al manifest.");
} else {
  console.log("El intent de compartir ya estaba presente.");
}
