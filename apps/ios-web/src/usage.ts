/* Account-usage sheet — the phone's equivalent of the ClaudeUsageBar
   popover on the Mac and UsageView on the watch. Renders the usage API's
   `limits` array (session, weekly all-models, per-model scoped weeklies)
   as meter rows, with the legacy five_hour/seven_day buckets as a fallback
   for older payloads and the extra-usage credits line when enabled.

   Data rides GET /usage on the gateway (daemons/gateway/src/usage.ts), a
   payload-compatible port of the watch bridge's UsageFetcher with a 60 s
   server-side cache — so the sheet can refresh freely without hammering
   the OAuth endpoint. Fetched via platform.httpRequest, whose
   gateway-relative path branch attaches the bearer token natively.

   Bespoke overlay rather than the platform Modal shim: the shim's chrome
   (title bar, close button geometry) is sized for desktop content, and
   this sheet wants the bottom-sheet shape iOS users expect. Same
   pattern as the shell's other after-the-fact surfaces: ios-web owns it,
   src/ is untouched. */

import { platform } from "../../../src/platform";

type LimitScopeEntity = { id?: string; display_name?: string };
type LimitEntry = {
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: LimitScopeEntity; surface?: LimitScopeEntity };
};
type UsageBucket = { utilization?: number; resets_at?: string };
type UsagePayload = {
  limits?: LimitEntry[];
  five_hour?: UsageBucket;
  seven_day?: UsageBucket;
  extra_usage?: {
    is_enabled?: boolean;
    utilization?: number;
    used_credits?: number;
    monthly_limit?: number;
  };
  error?: string;
};

type MeterRow = { label: string; percent: number | undefined; resetsAt: string | undefined };

/* The currently-open sheet's close(), if any — lets the singleton branch
   below actually tear down the previous sheet's interval instead of just
   detaching its DOM, which used to leak a 60s poll per open/close cycle. */
let activeClose: (() => void) | null = null;

/* Mirrors ClaudeUsageBar's LimitEntry.displayLabel so the two surfaces
   name the same bucket the same way. */
function limitLabel(entry: LimitEntry): string {
  switch (entry.kind) {
    case "session": return "Current Session";
    case "weekly_all": return "7-Day (All Models)";
    default: {
      const scoped = entry.scope?.model ?? entry.scope?.surface;
      const name = scoped?.display_name ?? scoped?.id;
      return name ? `7-Day ${name}` : "7-Day (Other)";
    }
  }
}

function meterRows(payload: UsagePayload): MeterRow[] {
  if (payload.limits && payload.limits.length > 0) {
    return payload.limits.map(entry => ({
      label: limitLabel(entry),
      percent: entry.percent,
      resetsAt: entry.resets_at,
    }));
  }
  /* Older payload shape: named buckets, utilization instead of percent. */
  const rows: MeterRow[] = [];
  if (payload.five_hour) rows.push({ label: "Current Session", percent: payload.five_hour.utilization, resetsAt: payload.five_hour.resets_at });
  if (payload.seven_day) rows.push({ label: "7-Day (All Models)", percent: payload.seven_day.utilization, resetsAt: payload.seven_day.resets_at });
  return rows;
}

function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return "";
  const deltaMs = at - now;
  if (deltaMs <= 0) return "resets soon";
  const totalMinutes = Math.round(deltaMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

/* Same thresholds as the watch complication rings. */
function levelClass(percent: number): string {
  if (percent >= 80) return "is-critical";
  if (percent >= 50) return "is-warning";
  return "is-ok";
}

export function showUsageSheet(): void {
  /* Singleton: a second tap on the header button while open just closes.
     Route through the sheet's own close() so its polling interval is
     cleared too — removing the element alone leaked the interval forever. */
  const existing = document.querySelector<HTMLElement>(".vaultgw-usage-overlay");
  if (existing) {
    activeClose?.();
    existing.remove();
    return;
  }

  const overlay = document.body.createDiv({ cls: "vaultgw-usage-overlay" });
  const sheet = overlay.createDiv({ cls: "vaultgw-usage-sheet" });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const head = sheet.createDiv({ cls: "vaultgw-usage-head" });
  head.createSpan({ cls: "vaultgw-usage-title", text: "Usage" });
  const closeBtn = head.createSpan({ cls: "vaultgw-usage-close", attr: { "aria-label": "Close" } });
  platform.setIcon(closeBtn, "x");
  closeBtn.addEventListener("click", close);

  const body = sheet.createDiv({ cls: "vaultgw-usage-body" });
  body.createDiv({ cls: "vaultgw-usage-empty", text: "Loading…" });

  /* Refresh while open so a sheet left up during a long turn stays honest;
     the gateway's 60 s cache makes the extra pulls free. */
  let closed = false;
  const timer = window.setInterval(() => void load(), 60_000);
  function close(): void {
    closed = true;
    window.clearInterval(timer);
    overlay.remove();
    if (activeClose === close) activeClose = null;
  }
  activeClose = close;

  async function load(): Promise<void> {
    let payload: UsagePayload;
    try {
      const res = await platform.httpRequest({ url: "/usage", throwOnError: false });
      if (res.status !== 200) {
        const err = (res.json as UsagePayload | undefined)?.error;
        render(null, err === "usage_credentials_missing" || err === "usage_auth_expired"
          ? "Sign in to ClaudeUsageBar on the Mac to enable usage data."
          : `Usage unavailable (status ${res.status}).`);
        return;
      }
      payload = (res.json ?? {}) as UsagePayload;
    } catch {
      render(null, "Gateway unreachable.");
      return;
    }
    render(payload, null);
  }

  function render(payload: UsagePayload | null, error: string | null): void {
    if (closed) return;
    body.empty();
    if (error || !payload) {
      body.createDiv({ cls: "vaultgw-usage-empty", text: error ?? "No usage data." });
      return;
    }
    const rows = meterRows(payload);
    if (rows.length === 0) {
      body.createDiv({ cls: "vaultgw-usage-empty", text: "No usage buckets in the response." });
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      const el = body.createDiv({ cls: "vaultgw-usage-row" });
      const top = el.createDiv({ cls: "vaultgw-usage-row-top" });
      top.createSpan({ cls: "vaultgw-usage-label", text: row.label });
      const pct = typeof row.percent === "number" ? Math.max(0, Math.min(100, row.percent)) : undefined;
      top.createSpan({ cls: "vaultgw-usage-pct", text: pct === undefined ? "–" : `${Math.round(pct)}%` });
      const track = el.createDiv({ cls: "vaultgw-usage-track" });
      if (pct !== undefined) {
        const fill = track.createDiv({ cls: `vaultgw-usage-fill ${levelClass(pct)}` });
        /* Sub-2% utilization still deserves a visible sliver. */
        fill.style.width = `${Math.max(pct, 1.5)}%`;
      }
      const reset = resetText(row.resetsAt, now);
      if (reset) el.createDiv({ cls: "vaultgw-usage-reset", text: reset });
    }
    const extra = payload.extra_usage;
    if (extra?.is_enabled) {
      const el = body.createDiv({ cls: "vaultgw-usage-extra" });
      const used = typeof extra.used_credits === "number" ? extra.used_credits / 100 : undefined;
      const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit / 100 : undefined;
      const usedText = used === undefined ? "–" : `$${used.toFixed(2)}`;
      el.setText(limit === undefined
        ? `Extra usage: ${usedText} this month`
        : `Extra usage: ${usedText} of $${limit.toFixed(2)} this month`);
    }
  }

  void load();
}
