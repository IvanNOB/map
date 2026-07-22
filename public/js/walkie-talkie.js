/**
 * Walkie-Talkie Module — Push-to-Talk Audio via Socket.IO
 * 
 * Usage:
 *   WalkieTalkie.init(socket, { role: 'admin'|'driver', driverId: N })
 *   WalkieTalkie.startTalking(driverId)  // admin specifies which driver
 *   WalkieTalkie.stopTalking()
 */

(function () {
  'use strict';

  let socket = null;
  let role = null;
  let currentDriverId = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let isTalking = false;
  let audioContext = null;

  window.WalkieTalkie = {

    /**
     * Initialize walkie-talkie
     * @param {object} sock - Socket.IO instance
     * @param {object} opts - { role: 'admin'|'driver', driverId: number (for driver only) }
     */
    init(sock, opts) {
      socket = sock;
      role = opts.role || 'driver';
      currentDriverId = opts.driverId || null;

      // Listen for incoming audio
      socket.on('walkie:audio', handleIncomingAudio);
      socket.on('walkie:talking', handleTalkingStatus);

      // Create audio context for playback
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    },

    /**
     * Start recording (push-to-talk)
     * @param {number} driverId - target driver (admin only)
     */
    async startTalking(driverId) {
      if (isTalking) return;
      
      const targetDriver = driverId || currentDriverId;
      if (!targetDriver && role === 'admin') return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        });

        isTalking = true;
        audioChunks = [];

        // Use lower quality for faster transmission
        const options = { mimeType: 'audio/webm;codecs=opus' };
        let mimeType = 'audio/webm;codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = 'audio/webm';
          if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/mp4';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
              mimeType = '';
            }
          }
        }

        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunks.push(e.data);
          }
        };

        mediaRecorder.onstop = () => {
          // Convert to base64 and send
          const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = reader.result;
            if (socket && socket.connected) {
              socket.emit('walkie:audio', {
                audio: base64,
                driverId: targetDriver,
              });
            }
          };
          reader.readAsDataURL(blob);

          // Stop all tracks
          stream.getTracks().forEach(t => t.stop());
        };

        mediaRecorder.start();

        // Notify others that we're talking
        socket.emit('walkie:talking', { talking: true, driverId: targetDriver });

        // Dispatch event for UI
        window.dispatchEvent(new CustomEvent('walkie:localTalking', { detail: { talking: true } }));

      } catch (err) {
        console.error('[Walkie] Microphone error:', err);
        isTalking = false;
        window.dispatchEvent(new CustomEvent('walkie:error', { detail: { message: 'No se pudo acceder al microfono' } }));
      }
    },

    /**
     * Stop recording and send audio
     */
    stopTalking() {
      if (!isTalking || !mediaRecorder) return;
      isTalking = false;

      if (mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }

      // Notify others
      const targetDriver = currentDriverId;
      socket.emit('walkie:talking', { talking: false, driverId: targetDriver });

      window.dispatchEvent(new CustomEvent('walkie:localTalking', { detail: { talking: false } }));
    },

    /**
     * Check if currently talking
     */
    isTalking() {
      return isTalking;
    },

    /**
     * Set target driver (for admin switching between drivers)
     */
    setTargetDriver(driverId) {
      currentDriverId = driverId;
    },
  };

  // ─── Handle incoming audio ────────────────────────────────────────────────

  function handleIncomingAudio(data) {
    if (!data || !data.audio) return;

    // Play the audio
    playAudio(data.audio);

    // Dispatch event for UI
    window.dispatchEvent(new CustomEvent('walkie:received', { 
      detail: { 
        sender_name: data.sender_name,
        sender_role: data.sender_role,
        driver_id: data.driver_id,
      } 
    }));
  }

  function handleTalkingStatus(data) {
    window.dispatchEvent(new CustomEvent('walkie:remoteTalking', { 
      detail: { 
        talking: data.talking,
        sender_name: data.sender_name,
        sender_role: data.sender_role,
      } 
    }));
  }

  // ─── Audio playback ───────────────────────────────────────────────────────

  async function playAudio(base64DataUrl) {
    try {
      // Resume audio context (needed after user interaction)
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Convert base64 data URL to ArrayBuffer
      const response = await fetch(base64DataUrl);
      const arrayBuffer = await response.arrayBuffer();

      // Decode and play
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start(0);

      // Play notification beep before audio
      playBeep('receive');

    } catch (err) {
      console.error('[Walkie] Playback error:', err);
      // Fallback: use Audio element
      try {
        const audio = new Audio(base64DataUrl);
        audio.volume = 1.0;
        await audio.play();
      } catch (e2) {
        console.error('[Walkie] Fallback playback failed:', e2);
      }
    }
  }

  function playBeep(type) {
    try {
      const ctx = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = type === 'receive' ? 800 : 600;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  }

})();
