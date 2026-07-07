/* contacts-ui.js — Frontend para directorio WhatsApp con etiquetas */
(function() {
  'use strict';

  var labels = [];
  var contacts = [];

  function getToken() { return localStorage.getItem('token') || ''; }
  function headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() }; }

  function escHtml(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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

  // ─── Render contacts grouped by label ──────────────────────────────────────
  function renderContacts() {
    var container = document.getElementById('contacts-container');
    if (!container) return;

    if (contacts.length === 0 && labels.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:2rem;">Agrega etiquetas y contactos para empezar</p>';
      return;
    }

    // Group contacts by label
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

    // Render each label section
    for (var j = 0; j < labels.length; j++) {
      var label = labels[j];
      var labelContacts = grouped[label.id] || [];
      html += '<div style="margin-bottom:1.2rem;">';
      html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">';
      html += '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:' + escHtml(label.color) + ';"></span>';
      html += '<strong style="font-size:0.95rem;">' + escHtml(label.name) + '</strong>';
      html += '<span style="font-size:0.75rem;color:var(--text-muted);">(' + labelContacts.length + ')</span>';
      html += '<button class="btn btn-outline btn-sm" style="font-size:0.65rem;padding:2px 6px;margin-left:auto;" data-del-label="' + label.id + '">🗑️</button>';
      html += '</div>';
      if (labelContacts.length === 0) {
        html += '<p style="color:var(--text-muted);font-size:0.8rem;padding-left:1.5rem;">Sin contactos en esta etiqueta</p>';
      } else {
        html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.5rem;padding-left:1.5rem;">';
        for (var k = 0; k < labelContacts.length; k++) {
          html += renderContactCard(labelContacts[k], label.color);
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // Contacts without label
    if (noLabel.length > 0) {
      html += '<div style="margin-bottom:1.2rem;">';
      html += '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem;">';
      html += '<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--text-muted);"></span>';
      html += '<strong style="font-size:0.95rem;">Sin etiqueta</strong>';
      html += '<span style="font-size:0.75rem;color:var(--text-muted);">(' + noLabel.length + ')</span>';
      html += '</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.5rem;padding-left:1.5rem;">';
      for (var m = 0; m < noLabel.length; m++) {
        html += renderContactCard(noLabel[m], 'var(--text-muted)');
      }
      html += '</div>';
      html += '</div>';
    }

    container.innerHTML = html;

    // Bind delete label buttons
    container.querySelectorAll('[data-del-label]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (confirm('Eliminar esta etiqueta?')) deleteLabel(btn.getAttribute('data-del-label'));
      });
    });

    // Bind delete contact buttons
    container.querySelectorAll('[data-del-contact]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (confirm('Eliminar este contacto?')) deleteContact(btn.getAttribute('data-del-contact'));
      });
    });
  }

  function renderContactCard(contact, borderColor) {
    var phone = String(contact.phone).replace(/[^0-9]/g, '');
    var waLink = phone ? 'https://wa.me/' + phone : '#';
    return '<div style="background:var(--panel);border:1px solid var(--border);border-left:3px solid ' + borderColor + ';border-radius:8px;padding:0.6rem 0.8rem;display:flex;align-items:center;gap:0.6rem;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:600;font-size:0.85rem;">' + escHtml(contact.name) + '</div>' +
        '<div style="font-size:0.75rem;color:var(--text-muted);">' + escHtml(contact.phone) + '</div>' +
        (contact.notes ? '<div style="font-size:0.7rem;color:var(--text-muted);font-style:italic;margin-top:2px;">' + escHtml(contact.notes) + '</div>' : '') +
      '</div>' +
      '<a href="' + waLink + '" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm" style="font-size:0.7rem;padding:4px 8px;">💬 WA</a>' +
      '<button class="btn btn-outline btn-sm" style="font-size:0.6rem;padding:2px 6px;" data-del-contact="' + contact.id + '">🗑️</button>' +
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
    if (!name || !phone) return;
    try {
      var res = await fetch('/api/contacts', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ name: name, phone: phone, label_id: label_id, notes: notes })
      });
      if (res.ok) {
        document.getElementById('new-contact-name').value = '';
        document.getElementById('new-contact-phone').value = '';
        document.getElementById('new-contact-notes').value = '';
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

    // Load when contactos tab is clicked
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
