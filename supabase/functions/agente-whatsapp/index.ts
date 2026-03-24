// agente-whatsapp/index.ts — v4 con memoria de clientes
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface Mensaje {
  role: "user" | "assistant" | "system";
  content: string;
}

interface RestauranteConfig {
  id: string;
  nombre: string;
  aforo_maximo: number;
  duracion_minutos: number;
  servicios: { nombre: string; inicio: number; fin: number }[];
  cobrar_senal: boolean;
  importe_senal_por_pax: number;
  mensaje_confirmacion: string;
  mensaje_completo: string;
}

interface ContextoCliente {
  es_nuevo: boolean;
  nombre?: string;
  total_visitas?: number;
  es_cliente_frecuente?: boolean;
  es_cliente_vip?: boolean;
  ultima_visita?: string;
  alergias?: string[];
  intolerancias?: string[];
  preferencias?: string[];
  necesidades_especiales?: string[];
  ocasiones?: { tipo: string; fecha: string }[];
  notas_personal?: string;
  tasa_no_show?: number;
  bloqueado?: boolean;
  historial_reciente?: { fecha: string; personas: number; notas: string; estado: string }[];
}

function minutosAHora(min: number): string {
  return String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0");
}

function horaAMinutos(hora: string): number {
  const limpia = hora.trim().replace(/[hH]s?\.?\s*/g, ":").replace(/\s/g, "");
  const [h, m] = limpia.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function fechaRelativaAISO(texto: string): string {
  const hoy = new Date();
  const lower = texto.toLowerCase().trim();
  if (lower === "hoy") return hoy.toISOString().split("T")[0];
  if (lower === "mañana") {
    const d = new Date(hoy); d.setDate(hoy.getDate() + 1);
    return d.toISOString().split("T")[0];
  }
  const dias: Record<string, number> = {
    lunes:1, martes:2, "miércoles":3, miercoles:3,
    jueves:4, viernes:5, "sábado":6, sabado:6, domingo:0
  };
  for (const [dia, num] of Object.entries(dias)) {
    if (lower.includes(dia)) {
      let diff = num - hoy.getDay();
      if (diff <= 0) diff += 7;
      const d = new Date(hoy); d.setDate(hoy.getDate() + diff);
      return d.toISOString().split("T")[0];
    }
  }
  const match = texto.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (match) {
    const anio = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : hoy.getFullYear().toString();
    return `${anio}-${match[2].padStart(2,"0")}-${match[1].padStart(2,"0")}`;
  }
  return texto;
}

// ── Construir contexto del cliente para el prompt ──
function buildContextoClienteTexto(ctx: ContextoCliente): string {
  if (ctx.es_nuevo) {
    return "CONTEXTO DEL CLIENTE: Cliente nuevo, primera vez que contacta.";
  }

  const lineas: string[] = [];
  lineas.push(`CONTEXTO DEL CLIENTE (usa esta info para personalizar la conversación):`);

  if (ctx.es_cliente_vip) lineas.push(`⭐ Cliente VIP — ${ctx.total_visitas} visitas. Trato preferencial.`);
  else if (ctx.es_cliente_frecuente) lineas.push(`🔄 Cliente frecuente — ${ctx.total_visitas} visitas.`);
  else lineas.push(`Total visitas: ${ctx.total_visitas}`);

  if (ctx.ultima_visita) lineas.push(`Última visita: ${ctx.ultima_visita}`);

  if (ctx.alergias?.length) lineas.push(`⚠️ Alergias conocidas: ${ctx.alergias.join(", ")} — IMPORTANTE mencionarlo`);
  if (ctx.intolerancias?.length) lineas.push(`⚠️ Intolerancias: ${ctx.intolerancias.join(", ")}`);
  if (ctx.preferencias?.length) lineas.push(`Preferencias: ${ctx.preferencias.join(", ")}`);
  if (ctx.necesidades_especiales?.length) lineas.push(`Necesidades especiales: ${ctx.necesidades_especiales.join(", ")}`);

  if (ctx.ocasiones?.length) {
    const hoy = new Date().toISOString().split("T")[0];
    const ocasionHoy = ctx.ocasiones.find(o => o.fecha === hoy);
    if (ocasionHoy) lineas.push(`🎉 HOY es su ${ocasionHoy.tipo} — considera ofrecerle un detalle de la casa`);
  }

  if (ctx.notas_personal) lineas.push(`Notas del equipo: ${ctx.notas_personal}`);

  if (ctx.tasa_no_show && ctx.tasa_no_show > 30) {
    lineas.push(`⚠️ Alta tasa de no-show (${ctx.tasa_no_show}%) — considera recordarle la reserva`);
  }

  if (ctx.historial_reciente?.length) {
    const ultima = ctx.historial_reciente[0];
    if (ultima.notas) lineas.push(`En su última visita anotó: "${ultima.notas}"`);
  }

  lineas.push(`INSTRUCCIÓN: Si el cliente ya ha visitado antes, salúdale por su nombre y hazle saber que le recuerdas. Si tiene alergias conocidas, pregúntale si siguen siendo las mismas en lugar de preguntar desde cero.`);

  return lineas.join("\n");
}

function buildSystemPrompt(restaurante: RestauranteConfig, contextoCliente?: ContextoCliente): string {
  const serviciosTexto = restaurante.servicios
    .map(s => `${s.nombre}: ${minutosAHora(s.inicio)}-${minutosAHora(s.fin)}`)
    .join(", ");
  const hoy = new Date();
  const fechaHoy = hoy.toISOString().split("T")[0];
  const diaHoy = hoy.toLocaleDateString("es-ES", { weekday:"long", day:"numeric", month:"long" });

  const contextoTexto = contextoCliente ? buildContextoClienteTexto(contextoCliente) : "";

  return `Eres el asistente virtual de ${restaurante.nombre}. Actúa como recepcionista amable y cercano, nunca robótico.

DATOS DEL RESTAURANTE:
- Horarios: ${serviciosTexto}
- Aforo máximo: ${restaurante.aforo_maximo} personas
- Duración media: ${restaurante.duracion_minutos} minutos
${restaurante.cobrar_senal ? `- Señal requerida: ${restaurante.importe_senal_por_pax}€ por persona (se descuenta de la consumición)` : ""}
- Hoy: ${diaHoy} (${fechaHoy})

${contextoTexto}

FLUJO DE RESERVA:
1. Recoge: nombre, fecha, hora, personas.
2. Si el cliente tiene alergias conocidas, pregunta si siguen siendo las mismas en lugar de preguntar desde cero.
3. Si es cliente nuevo, pregunta siempre por alergias/intolerancias y necesidades especiales.
4. Con todos los datos, confírmalos: "Solo para confirmar: Nombre: [X], Fecha: [X], Hora: [X], Personas: [X]. [Alergias]. ¿Todo correcto?"
5. Cuando el cliente diga "sí", "perfecto", "confirmado" o similar, incluye EXACTAMENTE este bloque en tu respuesta:
|||RESERVA|||{"restaurant_id":"${restaurante.id}","fecha":"YYYY-MM-DD","minutos_reserva":NNN,"personas":N,"nombre":"Nombre","telefono":"telefono","notas":"alergias y notas especiales"}|||FIN|||
   Después del bloque escribe tu mensaje de confirmación cálido.
6. Si hay cambios, actualiza y pide nueva confirmación.
${restaurante.cobrar_senal ? `7. IMPORTANTE: Este restaurante requiere señal de ${restaurante.importe_senal_por_pax}€/persona para confirmar la reserva.` : ""}

CANCELACIONES:
- Para buscar reserva: |||BUSCAR|||{"telefono":"tel","restaurant_id":"${restaurante.id}"}|||FIN|||
- Para cancelar: |||CANCELAR|||{"reserva_id":"id","restaurant_id":"${restaurante.id}"}|||FIN|||

REGLAS IMPORTANTES:
- NUNCA pongas el bloque JSON sin confirmación explícita del cliente
- El bloque JSON es invisible para el cliente, el sistema lo procesa automáticamente
- Tono siempre cálido y breve
- minutos_reserva: 840=14:00, 1200=20:00, 1260=21:00, 1230=20:30
- fecha siempre en formato YYYY-MM-DD`;
}

function extractCommand(text: string): {
  type: "RESERVA" | "BUSCAR" | "CANCELAR" | null;
  data: Record<string, unknown>;
  cleanText: string;
} {
  const pattern = /\|\|\|(\w+)\|\|\|([\s\S]*?)\|\|\|FIN\|\|\|/;
  const match = text.match(pattern);
  if (!match) return { type: null, data: {}, cleanText: text };

  const type = match[1] as "RESERVA" | "BUSCAR" | "CANCELAR";
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(match[2].trim()); }
  catch { console.error("JSON parse error:", match[2]); }

  const cleanText = text.replace(pattern, "").replace(/\n\n+/, "\n").trim();
  return { type, data, cleanText };
}

async function callMotor(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/motor-reservas`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function callGestionar(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/gestionar-reserva`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function callCrearSesionPago(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/crear-sesion-pago`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function callGroq(systemPrompt: string, messages: Mensaje[]): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}` },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 500,
      temperature: 0.7,
    }),
  });
  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) {
    console.error("Error Groq:", JSON.stringify(data));
    return "Lo siento, ha ocurrido un error. Por favor inténtalo de nuevo.";
  }
  return data.choices[0].message.content;
}

// ── Obtener contexto del cliente desde Supabase ──
async function getContextoCliente(
  supabase: ReturnType<typeof createClient>,
  restaurant_id: string,
  telefono: string
): Promise<ContextoCliente> {
  try {
    const { data, error } = await supabase.rpc("get_contexto_cliente", {
      p_restaurant_id: restaurant_id,
      p_telefono: telefono,
    });
    if (error || !data) return { es_nuevo: true };
    return data as ContextoCliente;
  } catch {
    return { es_nuevo: true };
  }
}

// ── Actualizar perfil con datos nuevos detectados en conversación ──
async function actualizarPerfilCliente(
  supabase: ReturnType<typeof createClient>,
  restaurant_id: string,
  telefono: string,
  updates: {
    alergias?: string[];
    intolerancias?: string[];
    preferencias?: string[];
    necesidades_especiales?: string[];
    ocasion?: string;
    fecha_ocasion?: string;
  }
) {
  try {
    const { data: cliente } = await supabase
      .from("clientes")
      .select("id, alergias, intolerancias, preferencias, necesidades_especiales, ocasiones")
      .eq("restaurant_id", restaurant_id)
      .eq("telefono", telefono)
      .single();

    if (!cliente) return;

    const patchData: Record<string, unknown> = {};

    if (updates.alergias?.length) {
      const existentes = cliente.alergias ?? [];
      const nuevas = updates.alergias.filter((a: string) => !existentes.includes(a));
      if (nuevas.length) patchData.alergias = [...existentes, ...nuevas];
    }

    if (updates.intolerancias?.length) {
      const existentes = cliente.intolerancias ?? [];
      const nuevas = updates.intolerancias.filter((a: string) => !existentes.includes(a));
      if (nuevas.length) patchData.intolerancias = [...existentes, ...nuevas];
    }

    if (updates.preferencias?.length) {
      const existentes = cliente.preferencias ?? [];
      const nuevas = updates.preferencias.filter((a: string) => !existentes.includes(a));
      if (nuevas.length) patchData.preferencias = [...existentes, ...nuevas];
    }

    if (updates.necesidades_especiales?.length) {
      const existentes = cliente.necesidades_especiales ?? [];
      const nuevas = updates.necesidades_especiales.filter((a: string) => !existentes.includes(a));
      if (nuevas.length) patchData.necesidades_especiales = [...existentes, ...nuevas];
    }

    if (updates.ocasion && updates.fecha_ocasion) {
      const existentes = cliente.ocasiones ?? [];
      patchData.ocasiones = [...existentes, { tipo: updates.ocasion, fecha: updates.fecha_ocasion }];
    }

    if (Object.keys(patchData).length > 0) {
      await supabase.from("clientes").update(patchData).eq("id", cliente.id);
    }
  } catch (err) {
    console.error("Error actualizando perfil:", err);
  }
}

async function getConversacion(supabase: ReturnType<typeof createClient>, telefono: string, restaurant_id: string): Promise<Mensaje[]> {
  try {
    const { data } = await supabase.from("conversaciones").select("mensajes")
      .eq("telefono", telefono).eq("restaurant_id", restaurant_id)
      .gte("updated_at", new Date(Date.now() - 30 * 60 * 1000).toISOString()).single();
    return data?.mensajes ?? [];
  } catch { return []; }
}

async function saveConversacion(supabase: ReturnType<typeof createClient>, telefono: string, restaurant_id: string, mensajes: Mensaje[]) {
  await supabase.from("conversaciones").upsert(
    { telefono, restaurant_id, mensajes: mensajes.slice(-20), updated_at: new Date().toISOString() },
    { onConflict: "telefono,restaurant_id" }
  );
}

async function sendWhatsApp(to: string, message: string, phoneNumberId: string) {
  await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: message } }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } });
  }

  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === Deno.env.get("WHATSAPP_VERIFY_TOKEN")) {
      return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return new Response("Bad request", { status: 400 }); }

  let mensaje_cliente = "", telefono_cliente = "", canal = "web", phone_number_id = "", restaurant_id = "";

  const waEntry = (body?.entry as unknown[])?.[0] as Record<string, unknown>;
  const waChanges = (waEntry?.changes as unknown[])?.[0] as Record<string, unknown>;
  const waValue = waChanges?.value as Record<string, unknown>;
  const waMessage = (waValue?.messages as unknown[])?.[0] as Record<string, unknown>;

  if (waMessage && waValue) {
    mensaje_cliente = (waMessage.text as { body?: string })?.body ?? "";
    telefono_cliente = "+" + String(waMessage.from ?? "");
    canal = "whatsapp";
    phone_number_id = String(waValue.phone_number_id ?? "");
    const { data: rest } = await supabase.from("restaurantes").select("id").eq("whatsapp_phone_id", phone_number_id).single();
    restaurant_id = rest?.id ?? Deno.env.get("DEFAULT_RESTAURANT_ID") ?? "";
  }

  if (!mensaje_cliente && body.mensaje) {
    mensaje_cliente = String(body.mensaje ?? "");
    telefono_cliente = String(body.telefono ?? "web-user");
    canal = String(body.canal ?? "web");
    restaurant_id = String(body.restaurant_id ?? "");
  }

  if (!mensaje_cliente || !restaurant_id) return new Response(JSON.stringify({ ok: true }));

  const { data: restData } = await supabase.from("restaurantes").select("*").eq("id", restaurant_id).eq("activo", true).single();
  if (!restData) return new Response(JSON.stringify({ ok: true }));

  const restaurante = restData as RestauranteConfig;

  // ── Obtener contexto del cliente ──
  const contextoCliente = await getContextoCliente(supabase, restaurant_id, telefono_cliente);

  // Si el cliente está bloqueado, no responder
  if (contextoCliente.bloqueado) {
    return new Response(JSON.stringify({ ok: true }));
  }

  const historial = await getConversacion(supabase, telefono_cliente, restaurant_id);
  const mensajes: Mensaje[] = [...historial, { role: "user", content: mensaje_cliente }];

  // UNA SOLA llamada a Groq con contexto del cliente
  const systemPrompt = buildSystemPrompt(restaurante, contextoCliente);
  const respuestaGroq = await callGroq(systemPrompt, mensajes);
  const { type, data, cleanText } = extractCommand(respuestaGroq);

  let respuestaFinal = cleanText;

  if (type === "RESERVA" && data.fecha && data.minutos_reserva !== undefined && data.personas && data.nombre) {
    if (typeof data.fecha === "string" && !data.fecha.match(/^\d{4}-/)) data.fecha = fechaRelativaAISO(data.fecha);
    if (typeof data.minutos_reserva === "string") data.minutos_reserva = horaAMinutos(data.minutos_reserva as string);
    if (!data.telefono) data.telefono = telefono_cliente;
    if (!data.origen) data.origen = canal;

    const disp = await callMotor({ ...data, solo_consulta: true });

    if (disp.status === "disponible") {
      if (restaurante.cobrar_senal) {
        const sesionPago = await callCrearSesionPago({
          restaurant_id: data.restaurant_id,
          fecha: data.fecha,
          minutos_inicio: disp.minutos_inicio,
          minutos_fin: disp.minutos_fin,
          personas: data.personas,
          nombre: data.nombre,
          telefono: data.telefono,
          notas: data.notas ?? "",
          origen: data.origen,
        });

        if (sesionPago.url_pago) {
          const importe = sesionPago.importe as number;
          const hora = disp.hora_inicio as string;
          respuestaFinal = `¡Genial! Tenemos disponibilidad el ${data.fecha} a las ${hora} para ${data.personas} persona${Number(data.personas) > 1 ? "s" : ""}.\n\nPara confirmar tu reserva necesitamos una señal de ${importe.toFixed(2)}€ (${restaurante.importe_senal_por_pax}€/persona) que se descontará de tu consumición.\n\nCompleta el pago aquí 👇\n${sesionPago.url_pago}\n\nTienes 30 minutos. ¡Te esperamos!`;
        } else {
          respuestaFinal = "Ha ocurrido un problema al procesar el pago. Por favor contacta directamente con el restaurante.";
        }
      } else {
        const confirmacion = await callMotor({ ...data, minutos_reserva: disp.minutos_inicio ?? data.minutos_reserva, solo_consulta: false });
        if (confirmacion.status === "confirmada") {
          // Actualizar perfil con datos nuevos de la conversación
          if (data.notas) {
            const notas = String(data.notas).toLowerCase();
            const alergias: string[] = [];
            const necesidades: string[] = [];

            if (notas.includes("celiaco") || notas.includes("gluten")) alergias.push("celiaco");
            if (notas.includes("marisco")) alergias.push("marisco");
            if (notas.includes("lactosa")) alergias.push("lactosa");
            if (notas.includes("silla alta")) necesidades.push("silla alta");
            if (notas.includes("carrito")) necesidades.push("espacio carrito");
            if (notas.includes("cumpleaños")) {
              await actualizarPerfilCliente(supabase, restaurant_id, telefono_cliente, {
                ocasion: "cumpleaños",
                fecha_ocasion: String(data.fecha),
              });
            }
            if (notas.includes("aniversario")) {
              await actualizarPerfilCliente(supabase, restaurant_id, telefono_cliente, {
                ocasion: "aniversario",
                fecha_ocasion: String(data.fecha),
              });
            }

            if (alergias.length || necesidades.length) {
              await actualizarPerfilCliente(supabase, restaurant_id, telefono_cliente, {
                alergias,
                necesidades_especiales: necesidades,
              });
            }
          }

          if (!cleanText || cleanText.length < 15) {
            const esVip = contextoCliente.es_cliente_vip;
            const esFrecuente = contextoCliente.es_cliente_frecuente;
            const saludo = esVip
              ? `¡Perfecto! Un placer volver a tenerle, ${data.nombre}.`
              : esFrecuente
              ? `¡Perfecto! Como siempre, ${data.nombre}, encantados de recibirle.`
              : `¡Perfecto! Todo listo, ${data.nombre}.`;

            respuestaFinal = `${saludo} Te esperamos el ${data.fecha} a las ${disp.hora_inicio} para ${data.personas} persona${Number(data.personas) > 1 ? "s" : ""}. ${data.notas ? `Hemos anotado: ${data.notas}.` : ""} ¡Hasta pronto!`;
          }
        } else {
          respuestaFinal = "Ha ocurrido un problema al registrar la reserva. Por favor contacta directamente con el restaurante.";
        }
      }
    } else if (disp.status === "completo") {
      respuestaFinal = `Lo siento, el servicio está completo para esa hora. ${restaurante.mensaje_completo}`;
    } else {
      respuestaFinal = String(disp.mensaje ?? restaurante.mensaje_completo);
    }

  } else if (type === "BUSCAR") {
    const res = await callGestionar({ ...data, accion: "buscar" });
    if (res.status === "encontrada") {
      const lista = (res.reservas as { fecha: string; hora: string; personas: number; servicio: string; id: string }[])
        .map(r => `• ${r.fecha} a las ${r.hora} — ${r.personas} personas (${r.servicio || ""})`).join("\n");
      respuestaFinal = `Encontré estas reservas:\n${lista}\n¿Cuál deseas cancelar?`;
    } else {
      respuestaFinal = "No encuentro reservas activas con ese número de teléfono.";
    }

  } else if (type === "CANCELAR") {
    const res = await callGestionar({ ...data, accion: "cancelar" });
    respuestaFinal = res.status === "cancelada"
      ? "Tu reserva ha sido cancelada correctamente. ¡Esperamos verte pronto!"
      : "No pude cancelar la reserva. Por favor contacta directamente con el restaurante.";
  }

  mensajes.push({ role: "assistant", content: respuestaFinal });
  await saveConversacion(supabase, telefono_cliente, restaurant_id, mensajes);

  if (canal === "whatsapp" && phone_number_id) {
    await sendWhatsApp(telefono_cliente, respuestaFinal, phone_number_id);
    return new Response(JSON.stringify({ ok: true }));
  }

  return new Response(
    JSON.stringify({ respuesta: respuestaFinal }),
    { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
  );
});