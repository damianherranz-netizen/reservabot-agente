// ============================================================
// EDGE FUNCTION: motor-reservas
// Reemplaza el blueprint de Make completo
// URL: https://<proyecto>.supabase.co/functions/v1/motor-reservas
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------- Tipos ----------
interface ReservaInput {
  restaurant_id: string;
  fecha: string;          // "YYYY-MM-DD"
  minutos_reserva: number; // minutos desde medianoche: 840 = 14:00
  personas: number;
  nombre: string;
  telefono?: string;
  email?: string;
  notas?: string;
  origen?: string;        // 'whatsapp' | 'sms' | 'web' | 'presencial'
}

interface Servicio {
  nombre: string;
  inicio: number;  // minutos desde medianoche
  fin: number;
}

interface Restaurante {
  id: string;
  nombre: string;
  aforo_maximo: number;
  duracion_minutos: number;
  servicios: Servicio[];
  calendario_google_id: string;
  google_refresh_token: string;
  cobrar_senal: boolean;
  importe_senal_por_pax: number;
  mensaje_confirmacion: string;
  mensaje_completo: string;
  activo: boolean;
}

// ---------- Helpers ----------

/**
 * Convierte minutos desde medianoche a string HH:MM
 */
function minutosAHora(minutos: number): string {
  const h = Math.floor(minutos / 60).toString().padStart(2, "0");
  const m = (minutos % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Construye un datetime ISO a partir de fecha y minutos
 * Para Google Calendar
 */
function fechaMinutosAISO(fecha: string, minutos: number): string {
  const date = new Date(`${fecha}T00:00:00`);
  date.setMinutes(date.getMinutes() + minutos);
  return date.toISOString();
}

/**
 * Detecta en qué servicio cae la hora solicitada
 */
function detectarServicio(
  minutosReserva: number,
  servicios: Servicio[]
): Servicio | null {
  return (
    servicios.find(
      (s) => minutosReserva >= s.inicio && minutosReserva < s.fin
    ) ?? null
  );
}

/**
 * Suma personas de reservas confirmadas en un rango de tiempo
 * Lógica idéntica al filtro de Make:
 *   minutos_inicio < minutos_fin_nueva  AND  minutos_fin > minutos_inicio_nueva
 */
async function contarPersonasEnFranja(
  supabase: ReturnType<typeof createClient>,
  restaurant_id: string,
  fecha: string,
  minutos_inicio: number,
  minutos_fin: number
): Promise<number> {
  const { data, error } = await supabase
    .from("reservas")
    .select("personas")
    .eq("restaurant_id", restaurant_id)
    .eq("fecha", fecha)
    .eq("estado", "confirmada")
    .lt("minutos_inicio", minutos_fin)    // empieza antes del fin del nuevo
    .gt("minutos_fin", minutos_inicio);   // termina después del inicio del nuevo

  if (error) throw new Error(`Error consultando reservas: ${error.message}`);

  return (data ?? []).reduce((acc, r) => acc + (r.personas ?? 0), 0);
}

/**
 * Crea evento en Google Calendar usando la API REST
 * Usa el refresh token del restaurante para obtener access token
 */
async function crearEventoCalendar(
  refreshToken: string,
  calendarId: string,
  summary: string,
  description: string,
  fechaInicio: string,
  fechaFin: string
): Promise<string | null> {
  try {
    // 1. Obtener access token con refresh token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GOOGLE_CLIENT_ID") ?? "",
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("Error obteniendo access token Google:", tokenData);
      return null;
    }

    // 2. Crear evento
    const eventRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          summary,
          description,
          start: { dateTime: fechaInicio, timeZone: "Europe/Madrid" },
          end: { dateTime: fechaFin, timeZone: "Europe/Madrid" },
          reminders: {
            useDefault: false,
            overrides: [{ method: "email", minutes: 60 }],
          },
        }),
      }
    );

    const eventData = await eventRes.json();
    return eventData.id ?? null;
  } catch (err) {
    console.error("Error creando evento Calendar:", err);
    return null;
  }
}

/**
 * Guarda la reserva en Supabase
 */
async function guardarReserva(
  supabase: ReturnType<typeof createClient>,
  input: ReservaInput,
  minutos_inicio: number,
  minutos_fin: number,
  tipo_turno: string,
  nombre_servicio: string,
  google_event_id: string | null,
  restaurante: Restaurante
) {
  const { error } = await supabase.from("reservas").insert({
    restaurant_id: input.restaurant_id,
    nombre: input.nombre,
    telefono: input.telefono ?? null,
    email: input.email ?? null,
    personas: input.personas,
    notas: input.notas ?? null,
    fecha: input.fecha,
    minutos_inicio,
    minutos_fin,
    tipo_turno,
    nombre_servicio,
    google_event_id,
    estado: "confirmada",
    senal_requerida: restaurante.cobrar_senal,
    senal_importe: restaurante.cobrar_senal
      ? restaurante.importe_senal_por_pax * input.personas
      : 0,
    origen: input.origen ?? "web",
  });

  if (error) throw new Error(`Error guardando reserva: ${error.message}`);
}

// ============================================================
// HANDLER PRINCIPAL
// ============================================================
Deno.serve(async (req) => {
  // CORS para llamadas desde web widget
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método no permitido" }), {
      status: 405,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  let input: ReservaInput;
  try {
    input = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ status: "error", mensaje: "JSON inválido" }),
      { status: 400 }
    );
  }

  // Validación básica
  const required = ["restaurant_id", "fecha", "minutos_reserva", "personas", "nombre"];
  for (const campo of required) {
    if (!input[campo as keyof ReservaInput]) {
      return new Response(
        JSON.stringify({ status: "error", mensaje: `Falta campo: ${campo}` }),
        { status: 400 }
      );
    }
  }

  try {
    // ── PASO 1: Cargar configuración del restaurante ──
    const { data: restData, error: restError } = await supabase
      .from("restaurantes")
      .select("*")
      .eq("id", input.restaurant_id)
      .eq("activo", true)
      .single();

    if (restError || !restData) {
      return new Response(
        JSON.stringify({
          status: "error",
          mensaje: "Restaurante no encontrado o inactivo",
        }),
        { status: 404 }
      );
    }

    const restaurante = restData as Restaurante;

    // ── PASO 2: Comprobar día cerrado ──
    const { data: diaCerrado } = await supabase
      .from("dias_cerrados")
      .select("id, motivo, servicios_cerrados, todo_el_dia")
      .eq("restaurant_id", input.restaurant_id)
      .eq("fecha", input.fecha)
      .single();

    if (diaCerrado) {
      // Detectar qué servicio es la hora solicitada
      const servicioSolicitado = detectarServicio(
        input.minutos_reserva,
        restaurante.servicios
      );
      const esTodoElDia = diaCerrado.todo_el_dia;
      const serviciosCerrados: string[] = diaCerrado.servicios_cerrados ?? [];

      const estaCerrado =
        esTodoElDia ||
        (servicioSolicitado &&
          serviciosCerrados.includes(servicioSolicitado.nombre));

      if (estaCerrado) {
        return new Response(
          JSON.stringify({
            status: "cerrado",
            mensaje: `El restaurante está cerrado ese día. ${
              diaCerrado.motivo ? `Motivo: ${diaCerrado.motivo}` : ""
            }`.trim(),
          }),
          { status: 200 }
        );
      }
    }

    // ── PASO 3: Detectar servicio y calcular franjas ──
    const servicio = detectarServicio(
      input.minutos_reserva,
      restaurante.servicios
    );

    if (!servicio) {
      return new Response(
        JSON.stringify({
          status: "fuera_horario",
          mensaje: "La hora solicitada está fuera del horario de servicio.",
        }),
        { status: 200 }
      );
    }

    // Igual que Make: todo en minutos
    const minutos_inicio_primer_turno = input.minutos_reserva;
    const minutos_fin_primer_turno =
      input.minutos_reserva + restaurante.duracion_minutos;

    // ── PASO 4: Contar personas en el primer turno ──
    const personasExistentes = await contarPersonasEnFranja(
      supabase,
      input.restaurant_id,
      input.fecha,
      minutos_inicio_primer_turno,
      minutos_fin_primer_turno
    );

    const hayAforo =
      personasExistentes + input.personas <= restaurante.aforo_maximo;

    // ── PASO 5A: HAY AFORO → confirmar primer turno ──
    if (hayAforo) {
      const horaInicio = minutosAHora(minutos_inicio_primer_turno);
      const horaFin = minutosAHora(minutos_fin_primer_turno);

      const summary = `Reserva – ${input.nombre} – ${input.personas} pax`;
      const description = [
        `Nombre: ${input.nombre}`,
        `Teléfono: ${input.telefono ?? "-"}`,
        `Personas: ${input.personas}`,
        `Notas: ${input.notas ?? "-"}`,
        `Origen: ${input.origen ?? "web"}`,
      ].join("\n");

      const eventId = await crearEventoCalendar(
        restaurante.google_refresh_token,
        restaurante.calendario_google_id,
        summary,
        description,
        fechaMinutosAISO(input.fecha, minutos_inicio_primer_turno),
        fechaMinutosAISO(input.fecha, minutos_fin_primer_turno)
      );

      await guardarReserva(
        supabase,
        input,
        minutos_inicio_primer_turno,
        minutos_fin_primer_turno,
        "primero",
        servicio.nombre,
        eventId,
        restaurante
      );

      return new Response(
        JSON.stringify({
          status: "confirmada",
          turno: "primero",
          hora_inicio: horaInicio,
          hora_fin: horaFin,
          servicio: servicio.nombre,
          mensaje: restaurante.mensaje_confirmacion,
          senal_requerida: restaurante.cobrar_senal,
          senal_importe: restaurante.cobrar_senal
            ? restaurante.importe_senal_por_pax * input.personas
            : 0,
        }),
        { status: 200 }
      );
    }

    // ── PASO 5B: NO HAY AFORO → intentar doblar mesa ──
    // El segundo turno empieza cuando termina el primero
    const minutos_inicio_segundo_turno = minutos_fin_primer_turno;
    const minutos_fin_segundo_turno =
      minutos_inicio_segundo_turno + restaurante.duracion_minutos;

    // Verificar que el segundo turno cabe dentro del horario del servicio
    const segundoTurnoDentroDeHorario =
      minutos_fin_segundo_turno <= servicio.fin;

    if (!segundoTurnoDentroDeHorario) {
      // No hay posibilidad ni de doblar: servicio completo
      return new Response(
        JSON.stringify({
          status: "completo",
          mensaje: restaurante.mensaje_completo,
        }),
        { status: 200 }
      );
    }

    // Contar personas en el segundo turno
    const personasSegundoTurno = await contarPersonasEnFranja(
      supabase,
      input.restaurant_id,
      input.fecha,
      minutos_inicio_segundo_turno,
      minutos_fin_segundo_turno
    );

    const hayAforoSegundoTurno =
      personasSegundoTurno + input.personas <= restaurante.aforo_maximo;

    if (!hayAforoSegundoTurno) {
      return new Response(
        JSON.stringify({
          status: "completo",
          mensaje: restaurante.mensaje_completo,
        }),
        { status: 200 }
      );
    }

    // ── PASO 6: Confirmar SEGUNDO turno (doblar mesa) ──
    const horaInicioSegundo = minutosAHora(minutos_inicio_segundo_turno);
    const horaFinSegundo = minutosAHora(minutos_fin_segundo_turno);

    const summarySegundo = `Reserva – ${input.nombre} – ${input.personas} pax`;
    const descSegundo = [
      `Nombre: ${input.nombre}`,
      `Teléfono: ${input.telefono ?? "-"}`,
      `Personas: ${input.personas}`,
      `Notas: ${input.notas ?? "-"}`,
      `Turno: segundo turno (mesa doblada)`,
      `Origen: ${input.origen ?? "web"}`,
    ].join("\n");

    const eventIdSegundo = await crearEventoCalendar(
      restaurante.google_refresh_token,
      restaurante.calendario_google_id,
      summarySegundo,
      descSegundo,
      fechaMinutosAISO(input.fecha, minutos_inicio_segundo_turno),
      fechaMinutosAISO(input.fecha, minutos_fin_segundo_turno)
    );

    await guardarReserva(
      supabase,
      input,
      minutos_inicio_segundo_turno,
      minutos_fin_segundo_turno,
      "segundo",
      servicio.nombre,
      eventIdSegundo,
      restaurante
    );

    return new Response(
      JSON.stringify({
        status: "confirmada",
        turno: "segundo",
        hora_inicio: horaInicioSegundo,
        hora_fin: horaFinSegundo,
        servicio: servicio.nombre,
        mensaje: `Su primera opción estaba completa. Le hemos reservado mesa a las ${horaInicioSegundo}. ${restaurante.mensaje_confirmacion}`,
        senal_requerida: restaurante.cobrar_senal,
        senal_importe: restaurante.cobrar_senal
          ? restaurante.importe_senal_por_pax * input.personas
          : 0,
      }),
      { status: 200 }
    );
  } catch (err) {
    console.error("Error en motor-reservas:", err);
    return new Response(
      JSON.stringify({
        status: "error",
        mensaje: "Error interno del servidor",
      }),
      { status: 500 }
    );
  }
});
