const socket = io();

// --- Map setup -------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView([40.4168, -3.7038], 12); // Madrid default

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// --- State -----------------------------------------------------------------
const markers = new Map(); // id -> L.marker
const data = new Map(); // id -> vehicle object
let hasFitOnce = false;

const listEl = document.getElementById("vehicle-list");
const countEl = document.getElementById("count");
const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");

function truckIcon() {
  return L.divIcon({
    className: "truck-marker",
    html: '<div class="truck-pin">🚚</div>',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

function popupHtml(v) {
  const speed = v.speed != null ? (v.speed * 3.6).toFixed(1) + " km/h" : "—";
  const acc = v.accuracy != null ? Math.round(v.accuracy) + " m" : "—";
  const updated = new Date(v.updatedAt).toLocaleTimeString();
  return `
    <strong>${escapeHtml(v.name)}</strong><br/>
    Velocidad: ${speed}<br/>
    Precisión: ${acc}<br/>
    Actualizado: ${updated}
  `;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function upsertVehicle(v) {
  data.set(v.id, v);

  if (markers.has(v.id)) {
    const m = markers.get(v.id);
    m.setLatLng([v.lat, v.lng]);
    m.setPopupContent(popupHtml(v));
  } else {
    const m = L.marker([v.lat, v.lng], { icon: truckIcon() })
      .addTo(map)
      .bindPopup(popupHtml(v));
    markers.set(v.id, m);
  }

  if (!hasFitOnce && markers.size > 0) {
    map.setView([v.lat, v.lng], 14);
    hasFitOnce = true;
  }

  renderList();
}

function removeVehicle(id) {
  if (markers.has(id)) {
    map.removeLayer(markers.get(id));
    markers.delete(id);
  }
  data.delete(id);
  renderList();
}

function renderList() {
  countEl.textContent = data.size;

  if (data.size === 0) {
    listEl.innerHTML = '<li class="empty">No hay vehículos en línea.</li>';
    return;
  }

  const items = [...data.values()].map((v) => {
    const speed = v.speed != null ? (v.speed * 3.6).toFixed(0) + " km/h" : "—";
    const updated = new Date(v.updatedAt).toLocaleTimeString();
    return `
      <li class="vehicle-item" data-id="${v.id}">
        <div class="vi-top">
          <span class="vi-dot"></span>
          <span class="vi-name">${escapeHtml(v.name)}</span>
        </div>
        <div class="vi-meta">${speed} · ${updated}</div>
      </li>`;
  });
  listEl.innerHTML = items.join("");

  // Click a list item to fly to that vehicle.
  listEl.querySelectorAll(".vehicle-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.getAttribute("data-id");
      const v = data.get(id);
      if (v) {
        map.flyTo([v.lat, v.lng], 16);
        markers.get(id)?.openPopup();
      }
    });
  });
}

// --- Socket events ---------------------------------------------------------
socket.on("connect", () => {
  connDot.className = "dot dot-on";
  connText.textContent = "Conectado";
  socket.emit("dispatcher:join");
});

socket.on("disconnect", () => {
  connDot.className = "dot dot-off";
  connText.textContent = "Desconectado";
});

socket.on("vehicles:snapshot", (vehicles) => {
  // Reset to the authoritative snapshot.
  for (const id of [...markers.keys()]) removeVehicle(id);
  vehicles.forEach(upsertVehicle);
});

socket.on("vehicle:update", upsertVehicle);
socket.on("vehicle:offline", ({ id }) => removeVehicle(id));
