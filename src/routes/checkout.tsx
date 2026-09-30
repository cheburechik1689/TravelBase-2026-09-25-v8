import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { SiteShell } from "@/components/site-shell";
import { apiFetch, formatRub } from "@/lib/travelbase/api-client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/checkout")({
  validateSearch: (s: Record<string, unknown>) => ({
    offer: typeof s.offer === "string" ? s.offer : "plus-month",
  }),
  component: Checkout,
});

function formatCard(v: string) {
  return v
    .replace(/\D/g, "")
    .slice(0, 19)
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function Checkout() {
  const { offer: offerId } = Route.useSearch();
  const { user, isPending } = useCurrentUserState();
  const [amount, setAmount] = useState<number | null>(null);
  const [title, setTitle] = useState("TravelBase Plus");
  const [period, setPeriod] = useState("");
  const [card, setCard] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [holder, setHolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    void apiFetch("/api/offers").then(({ data }) => {
      const list = Array.isArray(data.offers)
        ? (data.offers as { id: string; title: string; subtitle: string; price_rub: number }[])
        : [];
      const offer = list.find((o) => o.id === offerId) || list[0];
      if (!offer) return;
      setAmount(Number(offer.price_rub));
      setTitle(offer.title);
      setPeriod(offer.subtitle);
    });
  }, [offerId]);

  const displayAmount = useMemo(() => (amount != null ? formatRub(amount) : "…"), [amount]);

  if (isPending) {
    return (
      <SiteShell>
        <div className="h-48 animate-pulse rounded-2xl bg-plum/8" />
      </SiteShell>
    );
  }
  if (!user) return <Navigate to="/login" search={{ next: `/checkout?offer=${offerId}` }} />;

  if (done) {
    return (
      <SiteShell>
        <Navigate to="/cabinet" />
        <h1 className="text-2xl font-bold">Подписка активна</h1>
        <p className="mt-2 text-ink/60">Plus действует до {expiresAt ? new Date(expiresAt).toLocaleDateString("ru-RU") : "следующего периода"}.</p>
        <Link to="/" className="mt-6 inline-flex h-12 items-center rounded-xl bg-teal px-5 text-[14px] font-semibold text-cloud no-underline">
          Собрать полный маршрут
        </Link>
      </SiteShell>
    );
  }

  async function pay(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const created = await apiFetch("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ offerId }),
    });
    const { ok, data } = created;
    if (!ok) {
      setBusy(false);
      setError(String(data.error || "Оплата не прошла"));
      return;
    }
    const purchaseId = (data as { purchaseId?: string }).purchaseId;
    const paid = await apiFetch("/api/billing/complete", {
      method: "POST",
      body: JSON.stringify({
        purchaseId,
        cardNumber: card.replace(/\s+/g, ""),
        expiry,
        cvc,
        holder,
      }),
    });
    setBusy(false);
    if (!paid.ok) {
      setError(String(paid.data.error || "Оплата не прошла"));
      return;
    }
    const sub = paid.data.subscription as { expiresAt?: string } | undefined;
    setExpiresAt(sub?.expiresAt || "");
    setDone(true);
  }

  return (
    <SiteShell>
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-plum">PaySelection</p>
      <h1 className="text-2xl font-bold leading-tight tracking-tight">Оплата картами РФ и СНГ</h1>
      <p className="mt-2 text-[14px] text-ink/60">
        {title} · {period} · <span className="font-semibold text-signal">{displayAmount}</span>. МИР, Visa, Mastercard.
      </p>

      <div className="mt-6 rounded-2xl border border-plum/10 bg-card p-5">
        <div className="mb-4 flex items-center justify-between text-[12px] font-medium text-ink/50">
          <span>Защищённый платёж</span>
          <span>PaySelection</span>
        </div>
        <form onSubmit={pay} className="space-y-3">
          <label className="block text-[12px] font-medium text-ink/70">
            Номер карты
            <input
              inputMode="numeric"
              autoComplete="cc-number"
              required
              placeholder="2200 0000 0000 0000"
              className="mt-1 h-12 w-full rounded-xl border border-plum/15 px-3 font-mono text-[15px] tracking-wider outline-none focus:border-teal"
              value={card}
              onChange={(e) => setCard(formatCard(e.target.value))}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-[12px] font-medium text-ink/70">
              Срок
              <input
                required
                placeholder="ММ/ГГ"
                className="mt-1 h-12 w-full rounded-xl border border-plum/15 px-3 outline-none focus:border-teal"
                value={expiry}
                onChange={(e) => {
                  let v = e.target.value.replace(/\D/g, "").slice(0, 4);
                  if (v.length > 2) v = v.slice(0, 2) + "/" + v.slice(2);
                  setExpiry(v);
                }}
              />
            </label>
            <label className="block text-[12px] font-medium text-ink/70">
              CVC
              <input
                required
                inputMode="numeric"
                autoComplete="cc-csc"
                className="mt-1 h-12 w-full rounded-xl border border-plum/15 px-3 outline-none focus:border-teal"
                value={cvc}
                onChange={(e) => setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
            </label>
          </div>
          <label className="block text-[12px] font-medium text-ink/70">
            Имя на карте
            <input
              required
              autoComplete="cc-name"
              className="mt-1 h-12 w-full rounded-xl border border-plum/15 px-3 uppercase outline-none focus:border-teal"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
            />
          </label>
          {error && <p className="text-[13px] text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || amount == null}
            className="h-12 w-full rounded-xl bg-teal text-[14px] font-semibold text-cloud disabled:opacity-60"
          >
            {busy ? "Проводим платёж…" : `Оплатить ${displayAmount}`}
          </button>
        </form>
        <p className="mt-3 text-[11px] leading-relaxed text-ink/45">
          Тестовый контур PaySelection: для превью сойдёт 4242 4242 4242 4242, срок в будущем и любой CVC.
          В продакшене заявка уходит в шлюз, который принимает карты РФ и СНГ (МИР, Visa, Mastercard).
        </p>
      </div>

      <p className="mt-6 text-[12px] text-ink/45">
        <Link to="/offer" className="text-plum">
          Оферта
        </Link>
        {" · "}
        <Link to="/pricing" className="text-plum">
          Другой тариф
        </Link>
      </p>
    </SiteShell>
  );
}
