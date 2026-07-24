/**
 * Ghosty Voice Commands — Web Speech API integration for the admin panel.
 *
 * Allows the admin to speak commands to Ghosty:
 * - "Ghosty, crea un pedido para Juan en la calle 5"
 * - "Ghosty, qué pedidos hay pendientes?"
 * - "Ghosty, confirma el pedido"
 *
 * Also handles ghosty:suggest Socket.IO events to show assignment suggestions.
 */

(function () {
  'use strict';

  // ─── DOM Elements ───────────────────────────────────────────────────────────

  const ghostyPanel = document.getElementById('ghosty-voice-panel');
  const btnGhostyVoice = document.getElementById('btn-ghosty-voice');
  const ghostyTranscript = document.getElementById('ghosty-transcript');
  const ghostyResponse = document.getElementById('ghosty-response');
  const ghostyStatus = document.getElementById('ghosty-voice-status');
  const ghostySuggestions = document.getElementById('ghosty-suggestions');
  const btnGhostyClose = document.getElementById('btn-ghosty-voice-close');

  if (!ghostyPanel || !btnGhostyVoice) return;

  // ─── State ──────────────────────────────────────────────────────────────────

  let isListening = false;
  let recognition = null;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ─── Initialize Speech Recognition ─────────────────────────────────────────

  function initSpeechRecognition() {
    if (!SpeechRecognition) {
      setStatus('Tu navegador no soporta reconocimiento de voz', 'error');
      return false;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'es-CO';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListening = true;
      btnGhostyVoice.classList.add('listening');
      setStatus('Escuchando...', 'listening');
    };

    recognition.onend = () => {
      isListening = false;
      btnGhostyVoice.classList.remove('listening');
      setStatus('Listo', 'idle');
    };

    recognition.onerror = (event) => {
      isListening = false;
      btnGhostyVoice.classList.remove('listening');
      if (event.error === 'no-speech') {
        setStatus('No escuché nada. Intenta de nuevo.', 'idle');
      } else if (event.error === 'not-allowed') {
        setStatus('Permiso de micrófono denegado', 'error');
      } else {
        setStatus('Error: ' + event.error, 'error');
      }
    };

    recognition.onresult = (event) => {
      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (interim) {
        ghostyTranscript.textContent = interim;
        ghostyTranscript.classList.add('interim');
      }

      if (final) {
        ghostyTranscript.textContent = final;
        ghostyTranscript.classList.remove('interim');
        processVoiceCommand(final.trim());
      }
    };

    return true;
  }

  // ─── Toggle listening ───────────────────────────────────────────────────────

  function toggleListening() {
    if (!recognition && !initSpeechRecognition()) return;

    if (isListening) {
      recognition.stop();
    } else {
      ghostyTranscript.textContent = '';
      ghostyResponse.textContent = '';
      ghostyPanel.classList.remove('hidden');
      recognition.start();
    }
  }

  // ─── Process voice command ──────────────────────────────────────────────────

  async function processVoiceCommand(command) {
    if (!command || command.length < 2) return;

    setStatus('Procesando...', 'processing');
    ghostyResponse.textContent = '';
    ghostyResponse.classList.add('loading');

    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/ghosty/voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({ command }),
      });

      const data = await res.json();

      if (!res.ok) {
        ghostyResponse.textContent = data.error || 'Error al procesar el comando';
        ghostyResponse.classList.add('error');
      } else {
        ghostyResponse.textContent = data.reply || 'Comando procesado.';
        ghostyResponse.classList.remove('error');

        // If Ghosty created an order, show it
        if (data.action === 'create_order' && data.orderData) {
          ghostyResponse.textContent += '\n\n📦 Pedido creado: ' +
            (data.orderData.customer_name || 'Cliente') + ' → ' +
            (data.orderData.dropoff_address || '?');
        }

        // Speak the response
        speak(data.reply);
      }
    } catch (error) {
      ghostyResponse.textContent = 'Error de conexión';
      ghostyResponse.classList.add('error');
    } finally {
      ghostyResponse.classList.remove('loading');
      setStatus('Listo', 'idle');
    }
  }

  // ─── Text-to-Speech ─────────────────────────────────────────────────────────

  function speak(text) {
    if (!text || !window.speechSynthesis) return;
    // Stop any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text.slice(0, 200));
    utterance.lang = 'es-CO';
    utterance.rate = 1.1;
    utterance.pitch = 1.0;
    utterance.volume = 0.8;
    window.speechSynthesis.speak(utterance);
  }

  // ─── Ghosty Suggestions (Socket.IO) ────────────────────────────────────────

  function handleGhostySuggestion(data) {
    if (!ghostySuggestions) return;

    const card = document.createElement('div');
    card.className = 'ghosty-suggestion-card';
    card.dataset.orderId = data.order_id;

    const bestDriver = data.suggestions && data.suggestions[0];
    const driverOptions = (data.suggestions || []).map((s) =>
      '<option value="' + s.driver_id + '">' + s.driver_name +
      (s.distance_km != null ? ' (' + s.distance_km + ' km)' : '') + '</option>'
    ).join('');

    card.innerHTML = `
      <div class="ghosty-suggest-header">
        <span class="ghosty-suggest-icon">👻</span>
        <div>
          <strong>Ghosty sugiere asignar</strong>
          <span class="ghosty-suggest-code">${escapeHtml(data.order_code || '')}</span>
        </div>
      </div>
      <div class="ghosty-suggest-details">
        <div>👤 ${escapeHtml(data.customer_name || 'Cliente')}</div>
        <div>🏪 ${escapeHtml(data.pickup_address || '?')}</div>
        <div>📍 ${escapeHtml(data.dropoff_address || '?')}</div>
        ${data.items ? '<div>📦 ' + escapeHtml(data.items) + '</div>' : ''}
      </div>
      <div class="ghosty-suggest-driver">
        <label>🛵 Repartidor:</label>
        <select class="ghosty-driver-select">${driverOptions}</select>
      </div>
      <div class="ghosty-suggest-actions">
        <button class="btn btn-primary btn-sm ghosty-confirm-btn">✅ Confirmar</button>
        <button class="btn btn-outline btn-sm ghosty-reject-btn">❌ Manual</button>
      </div>
    `;

    ghostySuggestions.prepend(card);
    ghostySuggestions.classList.remove('hidden');

    // Play notification sound
    playGhostyAlert();

    // Speak announcement
    if (bestDriver) {
      speak('Ghosty sugiere asignar pedido a ' + bestDriver.driver_name);
    }

    // Event listeners
    card.querySelector('.ghosty-confirm-btn').addEventListener('click', async () => {
      const select = card.querySelector('.ghosty-driver-select');
      const driverId = parseInt(select.value);
      await confirmSuggestion(data.order_id, driverId, card);
    });

    card.querySelector('.ghosty-reject-btn').addEventListener('click', async () => {
      await rejectSuggestion(data.order_id, card);
    });

    // Auto-dismiss after 2 minutes
    setTimeout(() => {
      if (card.parentNode) card.remove();
      if (ghostySuggestions.children.length === 0) ghostySuggestions.classList.add('hidden');
    }, 120000);
  }

  async function confirmSuggestion(orderId, driverId, card) {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/ghosty/dispatch/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ order_id: orderId, driver_id: driverId }),
      });
      const data = await res.json();
      if (res.ok) {
        card.innerHTML = '<div class="ghosty-suggest-done">✅ Asignado a ' + escapeHtml(data.driver_name || 'repartidor') + '</div>';
        speak('Pedido asignado a ' + (data.driver_name || 'repartidor'));
        setTimeout(() => { card.remove(); if (ghostySuggestions.children.length === 0) ghostySuggestions.classList.add('hidden'); }, 5000);
      } else {
        card.querySelector('.ghosty-confirm-btn').textContent = data.error || 'Error';
      }
    } catch { card.querySelector('.ghosty-confirm-btn').textContent = 'Error de conexión'; }
  }

  async function rejectSuggestion(orderId, card) {
    try {
      const token = localStorage.getItem('token');
      await fetch('/api/ghosty/dispatch/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ order_id: orderId }),
      });
    } catch {}
    card.innerHTML = '<div class="ghosty-suggest-done">↩️ Asignación manual</div>';
    setTimeout(() => { card.remove(); if (ghostySuggestions.children.length === 0) ghostySuggestions.classList.add('hidden'); }, 3000);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  function setStatus(text, state) {
    if (!ghostyStatus) return;
    ghostyStatus.textContent = text;
    ghostyStatus.className = 'ghosty-voice-status ' + state;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function playGhostyAlert() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch {}
  }

  // ─── Close panel ────────────────────────────────────────────────────────────

  function closePanel() {
    if (recognition && isListening) recognition.stop();
    ghostyPanel.classList.add('hidden');
  }

  // ─── Bind events ───────────────────────────────────────────────────────────

  btnGhostyVoice.addEventListener('click', toggleListening);
  if (btnGhostyClose) btnGhostyClose.addEventListener('click', closePanel);

  // Keyboard shortcut: Ctrl+Shift+G to toggle Ghosty voice
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'G') {
      e.preventDefault();
      if (ghostyPanel.classList.contains('hidden')) {
        ghostyPanel.classList.remove('hidden');
      }
      toggleListening();
    }
  });

  // ─── Socket.IO integration ─────────────────────────────────────────────────
  // Wait for the global socket to be available (dispatcher.js creates it)

  function bindSocket() {
    if (window._ghostySocketBound) return;
    const checkSocket = setInterval(() => {
      if (typeof io !== 'undefined' && window._appSocket) {
        clearInterval(checkSocket);
        window._appSocket.on('ghosty:suggest', handleGhostySuggestion);
        window._appSocket.on('ghosty:confirmed', (data) => {
          // Remove card if still showing
          const card = ghostySuggestions?.querySelector('[data-order-id="' + data.order_id + '"]');
          if (card) card.remove();
        });
        window._ghostySocketBound = true;
      }
    }, 1000);
    // Stop checking after 30 seconds
    setTimeout(() => clearInterval(checkSocket), 30000);
  }

  bindSocket();
})();
