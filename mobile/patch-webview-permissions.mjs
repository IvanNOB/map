/**
 * Patch: Habilitar permisos de microfono en el WebView de Capacitor.
 * 
 * Busca MainActivity.java en el proyecto Android y lo reemplaza con
 * una version que auto-concede permisos de microfono al WebView.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Buscar MainActivity.java recursivamente en android/app/src/main/java
function findMainActivity(dir) {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findMainActivity(fullPath);
        if (found) return found;
      } else if (entry === "MainActivity.java") {
        return fullPath;
      }
    }
  } catch (_) {}
  return null;
}

const searchDir = "android/app/src/main/java";

if (!existsSync(searchDir)) {
  console.warn("⚠️  No se encontro el directorio android/. Saltando patch de WebView.");
  console.warn("   Asegurate de ejecutar: npx cap add android && npx cap sync");
  process.exit(0); // Exit 0 para no cancelar el build
}

const mainActivityPath = findMainActivity(searchDir);

if (!mainActivityPath) {
  console.warn("⚠️  MainActivity.java no encontrado. Saltando patch de WebView.");
  process.exit(0);
}

// Leer el paquete del archivo actual para mantenerlo
const currentContent = readFileSync(mainActivityPath, "utf8");
const packageMatch = currentContent.match(/^package\s+([\w.]+);/m);
const packageName = packageMatch ? packageMatch[1] : "com.agencia.domicilios";

console.log(`📦 Paquete detectado: ${packageName}`);
console.log(`📝 Modificando: ${mainActivityPath}`);

const newContent = `package ${packageName};

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity con soporte para microfono en WebView.
 * Permite walkie-talkie y otras funciones de audio/video.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();

        // Habilitar microfono/camara en el WebView
        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Auto-conceder permisos de audio y video solicitados por la web
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
`;

writeFileSync(mainActivityPath, newContent);
console.log("✅ MainActivity.java actualizado - microfono habilitado en WebView");
