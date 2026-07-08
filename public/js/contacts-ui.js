/* contacts-ui.js — Directorio WhatsApp con etiquetas plegables y ubicacion */
(function() {
  'use strict';

  var labels = [];
  var contacts = [];
  var collapsedLabels = JSON.parse(localStorage.getItem('contacts_collapsed') || '{}');

  function getToken() { return localStorage.getItem('token') || ''; }
  function headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() }; }
  function escHtml(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function saveCollapsed() { localStorage.setItem('contacts_collapsed', JSON.stringify(collapsedLabels)); }

  // ─── Load data ────────────────────────────────────────────────────────────
  async function loadLabels() {
    try {
      var res = await fetch('/api/contacts/labels', { headers: headers() });
      if (res.ok) labels = await res.json();
      populateLabelSelects();
    } catch(e) {}
  }

  async function loadContacts() {
    try {
      var res = await fetch('/api/contacts', { headers: headers() });
      if (res.ok) contacts = await res.json();
      renderContacts();
    } catch(e) {}
  }

  function populateLabelSelects() {
    var sel = document.getElementById('new-contact-label');
    if (!sel) return;
    sel.innerHTML = '<option value="">Sin etiqueta</option>' +
      labels.map(function(l) {
        return '<option value="' + l.id + '">' + escHtml(l.name) + '</option>';
      }).join('');
  }

  // ─── Render contacts grouped by label (COLLAPSIBLE) ────────────────────────
  function renderContacts() {
    var container = document.getElementById('contacts-container');
    if (!container) return;

    if (contacts.length === 0 && labels.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Agrega etiquetas y contactos para empezar</p>';
      return;
    }

    var grouped = {};
    var noLabel = [];
    for (var i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.label_id) {
        if (!grouped[c.label_id]) grouped[c.label_id] = [];
        grouped[c.label_id].push(c);
      } else {
        noLabel.push(c);
      }
    }

    var html = '';

    for (var j = 0; j < labels.length; j++) {
      var label = labels[j];
      var labelContacts = grouped[label.id] || [];
      var isCollapsed = collapsedLabels[label.id];
      html += '<div class="contact-section" style="margin-bottom:0.8rem;border:1px solid var(--border);border-radius:10px;overflow:hidden;">';
      // Header plegable
      html += '<div class="contact-section-head" data-toggle-label="' + label.id + '" style="display:flex;align-items:center;gap:0.5rem;padding:0.7rem 1rem;background:rgba(255,255,255,0.02);cursor:pointer;user-select:none;">';
      html += '<span style="font-size:0.8rem;transition:transform 0.2s;transform:rotate(' + (isCollapsed ? '0' : '90') + 'deg);">▶</span>';
      html += '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + escHtml(label.color) + ';flex-shrink:0;"></span>';
      html += '<strong style="font-size:0.9rem;flex:1;">' + escHtml(label.name) + '</strong>';
      html += '<span style="font-size:0.75rem;color:var(--text-muted);background:var(--bg-alt);padding:2px 8px;border-radius:10px;">' + labelContacts.length + '</span>';
      html += '<button class="btn btn-outline btn-sm" style="font-size:0.6rem;padding:2px 6px;" data-del-label="' + label.id + '">🗑️</button>';
      html += '</div>';
      // Content (plegable)
      html += '<div class="contact-section-body" data-label-body="' + label.id + '" style="' + (isCollapsed ? 'display:none;' : '') + 'padding:0.5rem 0.8rem;">';
      if (labelContacts.length === 0) {
        html += '<p style="color:var(--text-muted);font-size:0.8rem;padding:0.3rem 0;">Sin contactos</p>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:0.4rem;">';
        for (var k = 0; k < labelContacts.length; k++) {
          html += renderContactCard(labelContacts[k], label.color);
        }
        html += '</div>';
      }
      html += '</div></div>';
    }

    // Sin etiqueta
    if (noLabel.length > 0) {
      var noCollapsed = collapsedLabels['none'];
      html += '<div class="contact-section" style="margin-bottom:0.8rem;border:1px solid var(--border);border-radius:10px;overflow:hidden;">';
      html += '<div class="contact-section-head" data-toggle-label="none" style="display:flex;align-items:center;gap:0.5rem;padding:0.7rem 1rem;background:rgba(255,255,255,0.02);cursor:pointer;user-select:none;">';
      html += '<span style="font-size:0.8rem;transition:transform 0.2s;transform:rotate(' + (noCollapsed ? '0' : '90') + 'deg);">▶</span>';
      html += '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--text-muted);flex-shrink:0;"></span>';
      html += '<strong style="font-size:0.9rem;flex:1;">Sin etiqueta</strong>';
      html += '<span style="font-size:0.75rem;color:var(--text-muted);background:var(--bg-alt);padding:2px 8px;border-radius:10px;">' + noLabel.length + '</span>';
      html += '</div>';
      html += '<div class="contact-section-body" data-label-body="none" style="' + (noCollapsed ? 'display:none;' : '') + 'padding:0.5rem 0.8rem;">';
      html += '<div style="display:flex;flex-direction:column;gap:0.4rem;">';
      for (var m = 0; m < noLabel.length; m++) {
        html += renderContactCard(noLabel[m], 'var(--text-muted)');
      }
      html += '</div></div></div>';
    }

    container.innerHTML = html;

    // Bind collapsible toggle
    container.querySelectorAll('[data-toggle-label]').forEach(function(head) {
      head.addEventListener('click', function(e) {
        if (e.target.closest('[data-del-label]')) return; // don't toggle when deleting
        var id = head.getAttribute('data-toggle-label');
        var body = container.querySelector('[data-label-body="' + id + '"]');
        var arrow = head.querySelector('span:first-child');
        if (!body) return;
        var hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        if (arrow) arrow.style.transform = 'rotate(' + (hidden ? '90' : '0') + 'deg)';
        collapsedLabels[id] = !hidden;
        saveCollapsed();
      });
    });

    // Bind delete buttons
    container.querySelectorAll('[data-del-label]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (confirm('Eliminar esta etiqueta?')) deleteLabel(btn.getAttribute('data-del-label'));
      });
    });
    container.querySelectorAll('[data-del-contact]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (confirm('Eliminar este contacto?')) deleteContact(btn.getAttribute('data-del-contact'));
      });
    });
  }

  function renderContactCard(contact, borderColor) {
    var phone = String(contact.phone).replace(/[^0-9]/g, '');
    var waLink = phone ? 'https://wa.me/' + phone : '#';
    var hasLocation = contact.lat && contact.lng;
    var mapsLink = hasLocation ? 'https://www.google.com/maps?q=' + contact.lat + ',' + contact.lng : '';

    return '<div style="background:var(--panel);border:1px solid var(--border);border-left:3px solid ' + borderColor + ';border-radius:8px;padding:0.6rem 0.8rem;display:flex;align-items:center;gap:0.5rem;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(contact.name) + '</div>' +
        '<div style="font-size:0.75rem;color:var(--text-muted);">📱 ' + escHtml(contact.phone) + '</div>' +
        (contact.notes ? '<div style="font-size:0.7rem;color:var(--text-muted);font-style:italic;margin-top:1px;">' + escHtml(contact.notes) + '</div>' : '') +
        (hasLocation ? '<div style="font-size:0.65rem;color:var(--success);margin-top:1px;">📍 Ubicacion guardada</div>' : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:3px;flex-shrink:0;">' +
        '<a href="' + waLink + '" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm" style="font-size:0.65rem;padding:3px 7px;">💬 WA</a>' +
        (hasLocation ? '<a href="' + mapsLink + '" target="_blank" rel="noopener" class="btn btn-outline btn-sm" style="font-size:0.65rem;padding:3px 7px;">📍 Mapa</a>' : '') +
      '</div>' +
      '<button class="btn btn-outline btn-sm" style="font-size:0.6rem;padding:2px 5px;" data-del-contact="' + contact.id + '">🗑️</button>' +
    '</div>';
  }

  // ─── Actions ──────────────────────────────────────────────────────────────
  async function addLabel() {
    var name = document.getElementById('new-label-name').value.trim();
    var color = document.getElementById('new-label-color').value;
    if (!name) return;
    try {
      var res = await fetch('/api/contacts/labels', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ name: name, color: color })
      });
      if (res.ok) {
        document.getElementById('new-label-name').value = '';
        await loadLabels();
        await loadContacts();
      }
    } catch(e) {}
  }

  async function addContact() {
    var name = document.getElementById('new-contact-name').value.trim();
    var phone = document.getElementById('new-contact-phone').value.trim();
    var label_id = document.getElementById('new-contact-label').value || null;
    var notes = document.getElementById('new-contact-notes').value.trim();
    var lat = document.getElementById('new-contact-lat');
    var lng = document.getElementById('new-contact-lng');
    var latVal = lat ? parseFloat(lat.value) : null;
    var lngVal = lng ? parseFloat(lng.value) : null;
    if (!name || !phone) return;
    try {
      var body = { name: name, phone: phone, label_id: label_id, notes: notes };
      if (!isNaN(latVal) && !isNaN(lngVal) && latVal && lngVal) {
        body.lat = latVal;
        body.lng = lngVal;
      }
      var res = await fetch('/api/contacts', {
        method: 'POST', headers: headers(),
        body: JSON.stringify(body)
      });
      if (res.ok) {
        document.getElementById('new-contact-name').value = '';
        document.getElementById('new-contact-phone').value = '';
        document.getElementById('new-contact-notes').value = '';
        if (lat) lat.value = '';
        if (lng) lng.value = '';
        await loadContacts();
      }
    } catch(e) {}
  }

  async function deleteLabel(id) {
    try {
      await fetch('/api/contacts/labels/' + id, { method: 'DELETE', headers: headers() });
      await loadLabels();
      await loadContacts();
    } catch(e) {}
  }

  async function deleteContact(id) {
    try {
      await fetch('/api/contacts/' + id, { method: 'DELETE', headers: headers() });
      await loadContacts();
    } catch(e) {}
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    var btnLabel = document.getElementById('btn-add-label');
    if (btnLabel) btnLabel.addEventListener('click', addLabel);
    var btnContact = document.getElementById('btn-add-contact');
    if (btnContact) btnContact.addEventListener('click', addContact);

    document.addEventListener('click', function(e) {
      if (e.target && e.target.classList && e.target.classList.contains('tab-btn') &&
          e.target.getAttribute('data-tab') === 'contactos') {
        loadLabels();
        loadContacts();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
