const INJECTION_RE =
  /(ignore(\s+all)?\s+(previous|above|prior)\s+instructions|you are now|system\s*prompt|developer\s*mode|jailbreak|do not follow|forget (your|the) (instructions|rules)|забудь (предыдущие|все) инструкц|игнорируй (предыдущие|системные)|ты теперь|пиши код|write (python|javascript|code)|sudo |bitcoin|crypto miner|<\/?system>|```)/i;

const ROLE_LEAK_RE = /(as an? ai|language model|chatgpt|claude|gemini|grok)/i;

export function destinationKey(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'`]/g, "")
    .replace(/[.,/#!$%^&*;:{}=_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

export function sanitizeUserText(input: string, maxLen: number) {
  let s = String(input || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);

  if (INJECTION_RE.test(s) || ROLE_LEAK_RE.test(s)) {
    s = s
      .replace(INJECTION_RE, " ")
      .replace(ROLE_LEAK_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return s;
}

export function assertSafeDestination(raw: string) {
  const dest = sanitizeUserText(raw, 80);
  if (!dest || dest.length < 2) {
    return { ok: false as const, error: "Укажите город назначения" };
  }
  if (INJECTION_RE.test(dest)) {
    return { ok: false as const, error: "Некорректное направление" };
  }
  if (/https?:\/\//i.test(dest) || dest.includes("{") || dest.includes("<")) {
    return { ok: false as const, error: "Некорректное направление" };
  }
  return { ok: true as const, destination: dest, key: destinationKey(dest) };
}

export function wrapUserPayload(label: string, value: string) {
  // Delimiters stop the model from treating user text as new instructions.
  return `<${label}>${value}</${label}>`;
}
