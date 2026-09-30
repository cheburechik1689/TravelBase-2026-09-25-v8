import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, rateLimitKey } from "./rate-limit.ts";

const WINDOW_MS = 10 * 60 * 1000;
const T0 = 1_800_000_000_000;

describe("checkRateLimit", () => {
  it("allows requests up to the limit and then rejects with Retry-After", () => {
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(checkRateLimit("generate", "u:limit-hit", T0 + i * 1000), { ok: true });
    }
    const verdict = checkRateLimit("generate", "u:limit-hit", T0 + 10 * 1000);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.ok(verdict.retryAfterSec > 0);
      assert.ok(verdict.retryAfterSec <= WINDOW_MS / 1000);
    }
  });

  it("resets once the window slides past the oldest hit", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("generate", "u:window-reset", T0 + i * 1000);
    }
    assert.equal(checkRateLimit("generate", "u:window-reset", T0 + WINDOW_MS - 1).ok, false);
    assert.deepEqual(checkRateLimit("generate", "u:window-reset", T0 + WINDOW_MS), { ok: true });
  });

  it("tracks scopes and keys independently", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit("generate", "u:independent", T0 + i * 1000);
    }
    assert.equal(checkRateLimit("generate", "u:independent", T0 + 10 * 1000).ok, false);
    // другой пользователь того же scope не затронут
    assert.deepEqual(checkRateLimit("generate", "u:other", T0 + 10 * 1000), { ok: true });
    // knowledge-suggest имеет свой лимит 20
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(checkRateLimit("knowledge-suggest", "u:independent", T0 + i * 1000), {
        ok: true,
      });
    }
    assert.equal(checkRateLimit("knowledge-suggest", "u:independent", T0 + 20 * 1000).ok, false);
  });
});

describe("rateLimitKey", () => {
  it("prefers the user id when signed in", () => {
    const req = new Request("https://app/api/generate", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    assert.equal(rateLimitKey(req, "user-42"), "u:user-42");
  });

  it("takes the first address from x-forwarded-for, then x-real-ip", () => {
    const forwarded = new Request("https://app/api/generate", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1", "x-real-ip": "5.6.7.8" },
    });
    assert.equal(rateLimitKey(forwarded), "ip:1.2.3.4");
    const realIp = new Request("https://app/api/generate", {
      headers: { "x-real-ip": "5.6.7.8" },
    });
    assert.equal(rateLimitKey(realIp), "ip:5.6.7.8");
    const none = new Request("https://app/api/generate");
    assert.equal(rateLimitKey(none), "ip:unknown");
  });
});
