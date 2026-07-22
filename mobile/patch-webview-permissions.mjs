/**
 * Patch: Habilitar permisos de microfono en el WebView de Capacitor.
 * 
 * En Capacitor 6, el WebView concede permisos automaticamente SI el
 * AndroidManifest tiene los permisos declarados y el usuario los acepta
 * a nivel de sistema operativo.
 * 
 * Este patch asegura que la app pida el permiso RECORD_AUDIO al iniciar.
 * Modifica MainActivity.java para solicitar permisos de runtime en onCreate.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

// Buscar MainActivity.java recursivamente
function findFile(dir, filename) {
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findFile(fullPath, filename);
        if (found) return found;
      } else if (entry === filename) {
        return fullPath;
      }
    }
  } catch (_) {}
  return null;
}

const searchDir = "android/app/src/main/java";

if (!existsSync(searchDir)) {
  console.log("⚠️  Directorio android/ no encontrado. Saltando patch.");
  process.exit(0);
}

const mainActivityPath = findFile(searchDir, "MainActivity.java");

if (!mainActivityPath) {
  console.log("⚠️  MainActivity.java no encontrado. Saltando patch.");
  process.exit(0);
}

// Leer paquete del archivo actual
const currentContent = readFileSync(mainActivityPath, "utf8");
const packageMatch = currentContent.match(/^package\s+([\w.]+);/m);
const packageName = packageMatch ? packageMatch[1] : "com.agencia.domicilios";

console.log("📦 Paquete:", packageName);
console.log("📝 Archivo:", mainActivityPath);

const newContent = `package ${packageName};

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int PERMISSION_REQUEST_CODE = 200;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestAudioPermission();
    }

    private void requestAudioPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this,
                    new String[]{
                        Manifest.permission.RECORD_AUDIO,
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                    },
                    PERMISSION_REQUEST_CODE);
            }
        }
    }
}
`;

writeFileSync(mainActivityPath, newContent);
console.log("✅ MainActivity.java actualizado - solicita permiso de microfono al iniciar");
