/**
 * Kimi (Moonshot AI) — OpenAI-совместимый клиент для офлайн-экстракции
 * знаний из спарсенных документов. Не используется в request-цикле сервера
 * (там остаётся Grok/xAI): таймаут 30 с и ретраи рассчитаны на batch-режим.
 *
 * Env:
 *   MOONSHOT_API_KEY  — без него chatJson() возвращает null (см. kimiAvailable)
 *   MOONSHOT_BASE_URL — дефолт https://api.moonshot.ai/v1
 *   MOONSHOT_MODEL    — дефолт kimi-k2-0905-preview
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseUrl() {
  return (process.env.MOONSHOT_BASE_URL || "https://api.moonshot.ai/v1").replace(/\/+$/, "");
}

function model() {
  return process.env.MOONSHOT_MODEL || "kimi-k2-0905-preview";
}

/** Есть ли ключ — скрипты должны проверить это до старта и честно завершиться. */
export function kimiAvailable(): boolean {
  return Boolean(process.env.MOONSHOT_API_KEY?.trim());
}

export type ChatJsonOptions = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Дефолт 30 с (офлайн-экстракция); онлайн-контур передаёт меньше. */
  timeoutMs?: number;
};

/**
 * Один chat-completion с response_format: json_object. Возвращает распарсенный
 * JSON или null (нет ключа / не-JSON / ретраи исчерпаны). Ретраи (2, с backoff
 * 1s → 2s) — только на 429/5xx и сетевые сбои; 4xx — сразу null.
 */
export async function chatJson(opts: ChatJsonOptions): Promise<unknown | null> {
  const key = process.env.MOONSHOT_API_KEY?.trim();
  if (!key) return null;

  for (let attempt = 0; attempt <= 2; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: model(),
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 2000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch {
      // Сеть/таймаут — ретрай с backoff.
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return null;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return null;
    }
    if (!res.ok) return null;

    let content: string | undefined;
    try {
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      content = data?.choices?.[0]?.message?.content;
    } catch {
      return null;
    }
    if (!content) return null;
    try {
      return JSON.parse(content);
    } catch {
      // Модель иногда оборачивает JSON в ```json fences — достаём объект.
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
  }
  return null;
}
