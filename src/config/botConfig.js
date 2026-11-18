// Carrega a tabela bot_config (seed em db/migrations/010_bot_runtime.sql) e
// devolve os valores em camelCase, com cache em memoria e defaults.
//
// Decisoes:
// - Falha de consulta: registra aviso e devolve os defaults, sem cachear a
//   falha; a proxima chamada tenta de novo.
// - Cargas simultaneas compartilham a mesma consulta em andamento.
// - O objeto devolvido e congelado (profundamente), entao quem chama nao
//   consegue alterar o cache.

const DEFAULTS = Object.freeze({
  timezone: 'America/Bahia',
  rescheduleMinNoticeHours: 24,
  cancelMinNoticeHours: 24,
  humanSupportHours: Object.freeze({
    start: '08:00',
    end: '18:00',
    days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  }),
  messageRetentionDays: null,
  bookingHorizonDays: 21,
  conversationStepTimeoutMinutes: 30,
  handoffSilenceHours: 12,
  cpfMaxAttempts: 3,
  maxMisunderstoodReplies: 3,
  reminderHoursBefore: Object.freeze([24, 4]),
});

// Converte "reschedule_min_notice_hours" em "rescheduleMinNoticeHours".
function toCamelCase(key) {
  return key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function cloneDefaults() {
  return {
    ...DEFAULTS,
    humanSupportHours: {
      ...DEFAULTS.humanSupportHours,
      days: [...DEFAULTS.humanSupportHours.days],
    },
    reminderHoursBefore: [...DEFAULTS.reminderHoursBefore],
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }

  return value;
}

function buildConfig(rows) {
  const config = cloneDefaults();
  const camelKeys = new Set(Object.keys(DEFAULTS));

  for (const row of rows) {
    const key = toCamelCase(row.key);

    // Chaves desconhecidas sao ignoradas.
    if (camelKeys.has(key) && row.value !== undefined) {
      config[key] = row.value;
    }
  }

  return deepFreeze(config);
}

export function createBotConfig({
  pool,
  ttlMs = 60000,
  logger = console,
  now = () => Date.now(),
} = {}) {
  let cache = null;
  let loading = null;

  async function load() {
    try {
      const result = await pool.query('select key, value from bot_config');
      return { config: buildConfig(result.rows), ok: true };
    } catch (error) {
      logger.warn?.(`bot_config: falha ao carregar, usando defaults: ${error.message}`);
      return { config: deepFreeze(cloneDefaults()), ok: false };
    }
  }

  async function get() {
    if (cache !== null && now() - cache.loadedAt < ttlMs) {
      return cache.config;
    }

    if (loading === null) {
      loading = load().then(({ config, ok }) => {
        if (ok) {
          cache = { config, loadedAt: now() };
          return config;
        }

        // Falha depois de um carregamento bom: mantém a última config válida
        // (stale) em vez de voltar aos defaults; tenta de novo na próxima chamada.
        return cache !== null ? cache.config : config;
      }).finally(() => {
        loading = null;
      });
    }

    return loading;
  }

  return { get };
}
