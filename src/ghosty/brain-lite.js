/**
 * Ghosty Lite — Bot conversacional basado en reglas (sin IA, sin costos).
 *
 * Flujo de toma de pedidos paso a paso:
 * 1. Cliente saluda o pide domicilio → se inicia conversación
 * 2. Ghosty pregunta: ¿De dónde recojo?
 * 3. Ghosty pregunta: ¿A qué dirección lo llevo?
 * 4. Ghosty pregunta: ¿A nombre de quién?
 * 5. Ghosty pregunta: ¿Qué se recoge? (artículos)
 * 6. Ghosty confirma y crea el pedido
 *
 * Comandos especiales:
 * - "cancelar" / "no" → cancela el pedido en curso
 * - "estado" / "mi pedido" → consulta estado del último pedido
 * - "hola" / "hey" → reinicia conversación
 */

import { findOrCreateClient, recordOrder } from "./client-memory.js";

// ─── Conversation state ───────────────────────────────────────────────────────

const conversations = new Map(); // phone -> { step, data, lastActivity }
const CONVERSATION_TTL_MS = 10 * 60 * 1000; // 10 minutos

const STEPS = {
  IDLE: "idle",
  ASK_PICKUP: "ask_pickup",
  ASK_ADDRESS: "ask_address",
  ASK_NAME: "ask_name",
  ASK_ITEMS: "ask_items",
  CONFIRM: "confirm",
};

function getConversation(phone) {
  const conv = conversations.get(phone);
  if (conv && Date.now() - conv.lastActivity < CONVERSATION_TTL_MS) {
    conv.lastActivity = Date.now();
    return conv;
  }
  const fresh = { step: STEPS.IDLE, data: {}, lastActivity: Date.now() };
  conversations.set(phone, fresh);
  return fresh;
}

function resetConversation(phone) {
  conversations.set(phone, { step: STEPS.IDLE, data: {}, lastActivity: Date.now() });
}

// Cleanup expired conversations
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of conversations) {
    if (now - conv.lastActivity >= CONVERSATION_TTL_MS) conversations.delete(phone);
  }
}, 60_000);
cleanupInterval.unref?.();

// ─── Message processing ───────────────────────────────────────────────────────

/**
 * Process an incoming message and return Ghosty's reply + action.
 *
 * @param {string} phone
 * @param {string} message
 * @param {object} options - { senderName }
 * @returns {{ reply: string, action: string|null, orderData: object|null }}
 */
export function processMessageLite(phone, message, options = {}) {
  const text = message.trim().toLowerCase();
  const conv = getConversation(phone);

  // ─── Cancel command ─────────────────────────────────────────────────────
  if (matchAny(text, ["cancelar", "cancela", "no quiero", "olvidalo", "olvídalo", "salir"])) {
    resetConversation(phone);
    return { reply: "Entendido, pedido cancelado. Si necesitas algo más, escríbeme. 👻", action: "cancel", orderData: null };
  }

  // ─── Status command ─────────────────────────────────────────────────────
  if (matchAny(text, ["estado", "mi pedido", "donde va", "dónde va", "ya viene", "tracking"])) {
    return { reply: "Para consultar tu pedido, entra a:\nhttps://map-rgi5.onrender.com/customer.html\n\nIngresa tu código de pedido (ej: ORD-XXXX). 👻", action: null, orderData: null };
  }

  // ─── Process by step ────────────────────────────────────────────────────

  switch (conv.step) {
    case STEPS.IDLE:
      return handleIdle(phone, text, conv, options);

    case STEPS.ASK_PICKUP:
      return handlePickup(phone, message, conv);

    case STEPS.ASK_ADDRESS:
      return handleAddress(phone, message, conv);

    case STEPS.ASK_NAME:
      return handleName(phone, message, conv, options);

    case STEPS.ASK_ITEMS:
      return handleItems(phone, message, conv);

    case STEPS.CONFIRM:
      return handleConfirm(phone, text, conv);

    default:
      resetConversation(phone);
      return { reply: "👻 ¡Hola! Soy Ghosty de Servicio Ghost. ¿Necesitas un domicilio? Escríbeme qué necesitas.", action: null, orderData: null };
  }
}

// ─── Step handlers ────────────────────────────────────────────────────────────

function handleIdle(phone, text, conv, options) {
  // Detect intent to order
  if (matchAny(text, ["hola", "hey", "buenas", "buenos", "hi", "ola", "domicilio", "pedido", "quiero", "necesito", "enviar", "llevar", "recoger", "pedir"])) {
    conv.step = STEPS.ASK_PICKUP;
    conv.data = { phone };

    // Check if client is known
    const greeting = options.senderName
      ? `👻 ¡Hola ${options.senderName}! Soy Ghosty de Servicio Ghost.`
      : "👻 ¡Hola! Soy Ghosty de Servicio Ghost.";

    return {
      reply: `${greeting}\n\n🛵 ¿Quieres pedir un domicilio?\n\n🏪 ¿De dónde recojo? (nombre del negocio o lugar)`,
      action: null,
      orderData: null,
    };
  }

  // Menu / help
  if (matchAny(text, ["menu", "menú", "ayuda", "help", "opciones", "que puedes", "qué puedes"])) {
    return {
      reply: "👻 Soy Ghosty, tu asistente de domicilios.\n\nPuedo ayudarte con:\n🛵 *Pedir un domicilio* — escribe \"quiero un domicilio\"\n📍 *Estado de tu pedido* — escribe \"estado\"\n❌ *Cancelar* — escribe \"cancelar\"\n\n¿Qué necesitas?",
      action: null,
      orderData: null,
    };
  }

  // Price info
  if (matchAny(text, ["precio", "cuanto", "cuánto", "vale", "cuesta", "tarifa", "valor"])) {
    return {
      reply: "💰 El valor del domicilio es:\n• $3,000 hasta las 9:00 PM\n• $4,000 después de las 9:00 PM\n\n¿Quieres pedir uno? Escribe \"domicilio\" 👻",
      action: null,
      orderData: null,
    };
  }

  // Default — assume they want to order
  conv.step = STEPS.ASK_PICKUP;
  conv.data = { phone };
  return {
    reply: "👻 ¡Hola! Soy Ghosty de Servicio Ghost.\n\n🏪 ¿De dónde recojo? (nombre del negocio o lugar)",
    action: null,
    orderData: null,
  };
}

function handlePickup(phone, message, conv) {
  const pickup = message.trim();
  if (pickup.length < 2) {
    return { reply: "🏪 Dime el nombre del negocio o lugar donde recojo. Ejemplo: \"Subway\" o \"Restaurante El Paisa\"", action: null, orderData: null };
  }
  conv.data.pickup_address = pickup;
  conv.step = STEPS.ASK_ADDRESS;
  return {
    reply: `📍 Perfecto, recojo en *${pickup}*.\n\n¿A qué dirección lo llevo? (dirección completa de entrega)`,
    action: null,
    orderData: null,
  };
}

function handleAddress(phone, message, conv) {
  const address = message.trim();
  if (address.length < 4) {
    return { reply: "📍 Necesito la dirección completa. Ejemplo: \"Calle 5 #20-15, Barrio Centro\"", action: null, orderData: null };
  }
  conv.data.dropoff_address = address;
  conv.step = STEPS.ASK_NAME;
  return {
    reply: "👤 ¿A nombre de quién va el pedido?",
    action: null,
    orderData: null,
  };
}

function handleName(phone, message, conv, options) {
  let name = message.trim();
  if (name.length < 2) {
    name = options.senderName || "Cliente";
  }
  conv.data.customer_name = name;
  conv.step = STEPS.ASK_ITEMS;
  return {
    reply: "📦 ¿Qué recojo? (describe los artículos o el pedido)",
    action: null,
    orderData: null,
  };
}

function handleItems(phone, message, conv) {
  const items = message.trim();
  if (items.length < 2) {
    return { reply: "📦 Dime qué recojo. Ejemplo: \"2 hamburguesas y una gaseosa\"", action: null, orderData: null };
  }
  conv.data.items = items;
  conv.step = STEPS.CONFIRM;

  const hour = new Date().getHours();
  const fare = hour >= 21 ? "$4,000" : "$3,000";

  return {
    reply: `👻 ¡Listo! Confirma tu pedido:\n\n🏪 *Recogida:* ${conv.data.pickup_address}\n📍 *Entrega:* ${conv.data.dropoff_address}\n👤 *Cliente:* ${conv.data.customer_name}\n📦 *Artículos:* ${conv.data.items}\n💰 *Domicilio:* ${fare}\n\n¿Está correcto? Responde *sí* para confirmar o *no* para cancelar.`,
    action: null,
    orderData: null,
  };
}

function handleConfirm(phone, text, conv) {
  if (matchAny(text, ["si", "sí", "yes", "confirmo", "confirmar", "dale", "va", "listo", "ok", "correcto", "bien"])) {
    const orderData = {
      customer_name: conv.data.customer_name || "Cliente WhatsApp",
      customer_phone: phone,
      pickup_address: conv.data.pickup_address || "",
      dropoff_address: conv.data.dropoff_address || "",
      items: conv.data.items || "",
      notes: "Pedido creado por Ghosty via WhatsApp",
    };

    resetConversation(phone);

    return {
      reply: "✅ ¡Pedido registrado! Te avisaremos cuando el repartidor salga a recogerlo.\n\nGracias por usar Servicio Ghost 👻🛵",
      action: "create_order",
      orderData,
    };
  }

  if (matchAny(text, ["no", "cancelar", "cambiar", "corregir"])) {
    resetConversation(phone);
    return { reply: "❌ Pedido cancelado. Si necesitas algo más, escríbeme. 👻", action: "cancel", orderData: null };
  }

  return { reply: "Responde *sí* para confirmar o *no* para cancelar el pedido. 👻", action: null, orderData: null };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchAny(text, keywords) {
  return keywords.some((kw) => text.includes(kw));
}

export { getConversation, resetConversation, STEPS };
