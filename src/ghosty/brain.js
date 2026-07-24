/**
 * Ghosty Brain — IA conversacional para toma de pedidos.
 *
 * Recibe un mensaje de un cliente (vía WhatsApp o voz del admin),
 * consulta la memoria del cliente, analiza con OpenAI y decide:
 *   - Pedir más información (dirección, producto, etc.)
 *   - Crear un pedido completo
 *   - Responder una pregunta general
 *
 * NO ejecuta acciones directamente sobre la base de datos de pedidos.
 * Retorna una estructura con la decisión para que el módulo llamante
 * (WhatsApp Connector o Voice) actúe.
 */

import config from "../config/index.js";
import logger from "../config/logger.js";
import { getClientContext } from "./client-memory.js";

const OPENAI_URL = "https://api.openai.com/v1/responses";

// ─── Conversation state (in-memory per phone, ephemeral) ──────────────────────

const conversations = new Map(); // phone -> { messages[], lastActivity, pendingOrder }
const CONVERSATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getConversation(phone) {
  const conv = conversations.get(phone);
  if (conv && Date.now() - conv.lastActivity < CONVERSATION_TTL_MS) {
    conv.lastActivity = Date.now();
    return conv;
  }
  const fresh = { messages: [], lastActivity: Date.now(), pendingOrder: null };
  conversations.set(phone, fresh);
  return fresh;
}

function clearConversation(phone) {
  conversations.delete(phone);
}

// Cleanup expired conversations periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of conversations) {
    if (now - conv.lastActivity >= CONVERSATION_TTL_MS) conversations.delete(phone);
  }
}, 60_000);
cleanupInterval.unref?.();

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres Ghosty, el asistente virtual de Servicio Ghost, una agencia de domicilios.

TU PERSONALIDAD:
- Amable, rápido y directo. Usas emojis moderadamente.
- Respondes SIEMPRE en español.
- Eres eficiente: no haces preguntas innecesarias.

TU FUNCIÓN:
- Tomar pedidos de domicilio por WhatsApp.
- Preguntar la información que falte para completar un pedido.
- Confirmar el pedido antes de crearlo.

INFORMACIÓN QUE NECESITAS PARA UN PEDIDO COMPLETO:
1. Nombre del cliente (si no lo tienes en memoria)
2. Dirección de ENTREGA (obligatorio)
3. Lugar de RECOGIDA o negocio (obligatorio)
4. Qué se va a recoger / artículos (obligatorio)
5. Notas especiales (opcional)

REGLAS:
- Si el cliente es frecuente y tiene dirección guardada, pregunta "¿Envío a [dirección guardada]?" 
- Si falta información, pregunta UNA cosa a la vez, no todas juntas.
- Cuando tengas toda la información, responde con un JSON de pedido.
- NUNCA inventes direcciones, productos ni precios.
- Si el cliente pregunta algo que no es un pedido (horarios, precios, estado), responde brevemente.
- El valor del domicilio es $${config.fareDay} hasta las 9PM y $${config.fareNight} después.

FORMATO DE RESPUESTA:
Cuando tengas TODA la información para crear el pedido, responde EXACTAMENTE así:

\`\`\`json
{"action":"create_order","data":{"customer_name":"...","customer_phone":"...","pickup_address":"...","dropoff_address":"...","items":"...","notes":"..."}}
\`\`\`

Si necesitas más información o solo estás conversando, responde texto normal SIN el bloque json.
Si el cliente confirma el pedido que le resumiste, usa el formato json.
Si el cliente dice "no" o quiere cancelar, responde amablemente y usa:
\`\`\`json
{"action":"cancel"}
\`\`\`
`;

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Process an incoming message and return Ghosty's decision.
 *
 * @param {string} phone - Client phone number
 * @param {string} message - The client's message text
 * @param {object} options - { senderName }
 * @returns {Promise<{ reply: string, action: string|null, orderData: object|null }>}
 */
export async function processMessage(phone, message, options = {}) {
  if (!config.openaiApiKey) {
    return {
      reply: "Lo siento, el asistente no está disponible en este momento. Un operador te atenderá pronto. 👻",
      action: null,
      orderData: null,
    };
  }

  const conversation = getConversation(phone);
  const clientContext = await getClientContext(phone);

  // Build context for OpenAI
  let contextBlock = "";
  if (clientContext) {
    contextBlock = `\nCONTEXTO DEL CLIENTE:\n- Nombre: ${clientContext.name}\n- Teléfono: ${phone}\n- Pedidos anteriores: ${clientContext.total_orders}\n- Cliente frecuente: ${clientContext.is_frequent ? "Sí" : "No"}`;
    if (clientContext.default_address) {
      contextBlock += `\n- Dirección guardada: ${clientContext.default_address}`;
    }
    if (clientContext.addresses?.length > 0) {
      contextBlock += `\n- Direcciones conocidas: ${clientContext.addresses.map((a) => a.label + ": " + a.address).join("; ")}`;
    }
  } else if (options.senderName) {
    contextBlock = `\nCONTEXTO DEL CLIENTE:\n- Nombre (de WhatsApp): ${options.senderName}\n- Teléfono: ${phone}\n- Cliente nuevo (primera vez)`;
  }

  // Add the new user message to conversation history
  conversation.messages.push({ role: "user", content: message });

  // Keep only last 12 messages to avoid token overflow
  if (conversation.messages.length > 12) {
    conversation.messages = conversation.messages.slice(-12);
  }

  // Build input for Responses API
  const inputMessages = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.assistantTimeoutMs);

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openaiModel,
        instructions: SYSTEM_PROMPT + contextBlock,
        input: inputMessages,
        max_output_tokens: 600,
        temperature: 0.7,
        store: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn("Ghosty Brain OpenAI error", { status: response.status });
      return {
        reply: "Disculpa, tuve un problema técnico. Intenta de nuevo en un momento. 👻",
        action: null,
        orderData: null,
      };
    }

    const payload = await response.json();
    const reply = extractReply(payload);

    if (!reply) {
      return {
        reply: "No entendí bien. ¿Puedes repetirlo? 👻",
        action: null,
        orderData: null,
      };
    }

    // Save assistant reply to conversation history
    conversation.messages.push({ role: "assistant", content: reply });

    // Check if the reply contains an action JSON
    const actionResult = parseAction(reply);

    if (actionResult.action === "create_order") {
      // Enrich with phone
      actionResult.orderData.customer_phone = phone;
      if (!actionResult.orderData.customer_name && clientContext?.name) {
        actionResult.orderData.customer_name = clientContext.name;
      }
      conversation.pendingOrder = actionResult.orderData;
      clearConversation(phone); // Order complete, reset conversation
    } else if (actionResult.action === "cancel") {
      clearConversation(phone);
    }

    logger.info("Ghosty Brain processed message", {
      phone: phone.slice(-4),
      action: actionResult.action || "conversation",
      messages_in_conv: conversation.messages?.length || 0,
    });

    return {
      reply: actionResult.cleanReply,
      action: actionResult.action,
      orderData: actionResult.orderData,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return {
        reply: "Estoy tardando mucho en responder. Intenta de nuevo. 👻",
        action: null,
        orderData: null,
      };
    }
    logger.error("Ghosty Brain error", { error: error?.message });
    return {
      reply: "Tuve un error procesando tu mensaje. Un operador te ayudará pronto. 👻",
      action: null,
      orderData: null,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractReply(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text.trim();
      }
    }
  }
  return null;
}

function parseAction(reply) {
  const jsonMatch = reply.match(/```json\s*\n?([\s\S]*?)\n?```/);

  if (!jsonMatch) {
    return { action: null, orderData: null, cleanReply: reply };
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    const cleanReply = reply.replace(/```json[\s\S]*?```/, "").trim();

    if (parsed.action === "create_order" && parsed.data) {
      return {
        action: "create_order",
        orderData: {
          customer_name: parsed.data.customer_name || "",
          customer_phone: parsed.data.customer_phone || "",
          pickup_address: parsed.data.pickup_address || "",
          dropoff_address: parsed.data.dropoff_address || "",
          items: parsed.data.items || "",
          notes: parsed.data.notes || "",
        },
        cleanReply: cleanReply || "Perfecto, voy a crear tu pedido. 👻✅",
      };
    }

    if (parsed.action === "cancel") {
      return {
        action: "cancel",
        orderData: null,
        cleanReply: cleanReply || "Entendido, pedido cancelado. ¿Necesitas algo más? 👻",
      };
    }

    return { action: null, orderData: null, cleanReply: reply };
  } catch {
    return { action: null, orderData: null, cleanReply: reply };
  }
}

/**
 * Process a voice command from the admin panel.
 * Different from client messages — admin can give direct instructions.
 */
export async function processAdminCommand(command) {
  if (!config.openaiApiKey) {
    return { reply: "OpenAI no está configurado.", action: null };
  }

  const adminPrompt = `Eres Ghosty, asistente de operaciones de Servicio Ghost.
El ADMINISTRADOR te da un comando de voz. Interpreta lo que quiere hacer:
- Si quiere crear un pedido, extrae la información y responde con el JSON de acción.
- Si pregunta por el estado de la operación, responde brevemente.
- Si da una instrucción sobre un repartidor (no asignarle más, está ocupado, etc.), reconócelo.

Responde siempre en español, breve y directo.
Usa el mismo formato JSON de acciones si corresponde.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.assistantTimeoutMs);

    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.openaiModel,
        instructions: adminPrompt,
        input: [{ role: "user", content: command }],
        max_output_tokens: 400,
        temperature: 0.5,
        store: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { reply: "Error al procesar el comando.", action: null };
    }

    const payload = await response.json();
    const reply = extractReply(payload);
    if (!reply) return { reply: "No entendí el comando.", action: null };

    const actionResult = parseAction(reply);
    return {
      reply: actionResult.cleanReply,
      action: actionResult.action,
      orderData: actionResult.orderData || null,
    };
  } catch (error) {
    logger.error("Ghosty admin command error", { error: error?.message });
    return { reply: "Error procesando el comando de voz.", action: null };
  }
}

export { getConversation, clearConversation };
