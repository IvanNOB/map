const socket = io();

const nameInput = document.getElementById("name");
const consentBox = document.getElementById("consent");
const toggleBtn = document.getElementById("toggle");
const statusEl = document.getElementById("status");

const latEl = document.getElementById("lat");
const lngEl = document.getElementById("lng");
const speedEl = document.getElementById("speed");
const accEl = document.getElementById("acc");
const timeEl = document.getElementById("time");

// A stable id per device so the dispatcher can keep tracking the same vehicle
// across reconnections. Stored locally on the driver's device only.
let driverId = localStorage.getItem("driverId");
if (!driverId) {
  driverId = "drv_" + Math.random().toString(36).slice(2, 10);
  localStorage.setItem("driverId", driverId);
}

const savedName = localStorage.getItem("driverName");
if (savedName) nameInput.value = savedName;

let watchId = null;
let sharing = false;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status " + cls;
}

// Enable the button only when consent is given.
consentBox.addEventListener("change", () => {
  toggleBtn.disabled = !consentBox.checked;
});

function startSharing() {
  if (!("geolocation" in navigator)) {
    setStatus("Tu navegador no soporta geolocalización", "status-error");
    return;
  }

  localStorage.setItem("driverName", nameInput.value.trim());
  setStatus("Solicitando permiso de ubicación…", "status-idle");

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, speed, heading, accuracy } = pos.coords;

      socket.emit("driver:update", {
        id: driverId,
        name: nameInput.value.trim() || undefined,
        lat: latitude,
        lng: longitude,
        speed: speed,
        heading: heading,
        accuracy: accuracy,
      });

      latEl.textContent = latitude.toFixed(5);
      lngEl.textContent = longitude.toFixed(5);
      speedEl.textContent =
        speed != null ? (speed * 3.6).toFixed(1) + " km/h" : "—";
      accEl.textContent = accuracy != null ? Math.round(accuracy) + " m" : "—";
      timeEl.textContent = new Date().toLocaleTimeString();

      setStatus("● Compartiendo ubicación", "status-live");
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        setStatus("Permiso de ubicación denegado", "status-error");
        stopSharing();
      } else {
        setStatus("Error obteniendo ubicación: " + err.message, "status-error");
      }
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    }
  );

  sharing = true;
  toggleBtn.textContent = "Dejar de compartir";
  toggleBtn.classList.remove("btn-primary");
  toggleBtn.classList.add("btn-danger");
  nameInput.disabled = true;
  consentBox.disabled = true;
}

function stopSharing() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  socket.emit("driver:stop");

  sharing = false;
  toggleBtn.textContent = "Empezar a compartir";
  toggleBtn.classList.add("btn-primary");
  toggleBtn.classList.remove("btn-danger");
  nameInput.disabled = false;
  consentBox.disabled = false;
  setStatus("Sin compartir", "status-idle");
}

toggleBtn.addEventListener("click", () => {
  if (sharing) stopSharing();
  else startSharing();
});

// Best-effort notice to the server if the page is closed.
window.addEventListener("beforeunload", () => {
  if (sharing) socket.emit("driver:stop");
});
