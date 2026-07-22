/**
 * Patch: Habilitar permisos de microfono en el WebView de Capacitor.
 * 
 * El WebView de Android por defecto NO concede permisos de microfono/camara
 * a las paginas web. Este script modifica el MainActivity.java generado
 * por Capacitor para sobreescribir onPermissionRequest() y conceder
 * automaticamente RESOURCE_AUDIO_CAPTURE.
 * 
 * Ejecutar despues de `npx cap add android` y `npx cap sync`.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const mainActivityPath = "android/app/src/main/java/com/agencia/domicilios/MainActivity.java";

if (!existsSync(mainActivityPath)) {
  console.error("❌ No se encontro MainActivity.java en:", mainActivityPath);
  console.error("   Ejecuta primero: npx cap add android && npx cap sync");
  process.exit(1);
}

const newContent = `package com.agencia.domicilios;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * MainActivity customizada para conceder permisos de microfono
 * al WebView automaticamente (necesario para walkie-talkie).
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();

        // Obtener el WebView de Capacitor y configurar WebChromeClient
        WebView webView = getBridge().getWebView();
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Conceder automaticamente permisos de audio y video al WebView
                runOnUiThread(() -> {
                    request.grant(request.getResources());
                });
            }
        });
    }
}
`;

writeFileSync(mainActivityPath, newContent);
console.log("✅ MainActivity.java modificado: permisos de microfono habilitados en WebView");
console.log("   Ahora ejecuta: npx cap sync && npx cap open android");
