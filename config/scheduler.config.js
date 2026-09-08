/**
 * scheduler.config.js
 * Configuración de las tareas programadas de Lucy (ver server.js#iniciarScheduler,
 * que usa node-cron para ejecutarlas). Cambiar horarios/umbrales aquí no requiere
 * tocar la lógica de server.js.
 *
 * IMPORTANTE — "no lo puede hacer a diario como SPAM" (pedido original): aunque cada
 * tarea SE EVALÚA a diario (o más seguido, ver valoracionInactividad), ninguna reenvía
 * el mismo mensaje al mismo destinatario indefinidamente:
 *  - recordatoriosPolizas respeta un enfriamiento mínimo entre recordatorios de una
 *    misma póliza (diasMinimosEntreRecordatorios) — ver data/notificaciones-programadas.json.
 *  - seguimientoCotizaciones marca cada cotización como "ya contactada"
 *    (quote.seguimientoEnviado) la primera vez — nunca se reintenta esa misma cotización.
 *  - valoracionInactividad solo pregunta una vez por conversación (record.ratingState).
 */

module.exports = {
  // Node-cron usa este huso horario para todas las expresiones de abajo.
  timezone: "America/Caracas",

  // 9:00 AM todos los días: WhatsApp al cliente y a su corredor por cada póliza que
  // vence dentro de `diasAntesVencimiento` días.
  recordatoriosPolizas: {
    enabled: true,
    cronExpression: "0 9 * * *",
    diasAntesVencimiento: 30,
    diasMinimosEntreRecordatorios: 7,
  },

  // 3:00 PM todos los días: Lucy envía un mensaje de seguimiento por cada cotización
  // sin cerrar (sin `formalRequest`) que lleva más de `horasSinCerrar` horas abierta.
  seguimientoCotizaciones: {
    enabled: true,
    cronExpression: "0 15 * * *",
    horasSinCerrar: 48,
  },

  // Cada 2 minutos: revisa conversaciones de WhatsApp inactivas hace
  // `minutosInactividad` minutos (el último mensaje fue de Lucy, sin respuesta desde
  // entonces) para preguntar la valoración de calidad — ver RATING_ASK_TEXT en
  // server.js. Solo WhatsApp: el widget web no tiene forma de recibir un mensaje del
  // servidor fuera de una conexión ya abierta (ver "Modo supervisor" para la excepción
  // de mensajes en vivo). `maxHorasConversacion` evita preguntar sobre conversaciones
  // viejas que quedaron abandonadas antes de que existiera esta función.
  valoracionInactividad: {
    enabled: true,
    cronExpression: "*/2 * * * *",
    minutosInactividad: 10,
    maxHorasConversacion: 24,
  },
};
