import type { CreditBalance, ProviderReport, RateLimit, UsageReport } from "../../index.js";
import { colorText, formatCompact, formatLocalDate, formatLocalTime, formatPercent, formatRelativeTime } from "./format.js";

export interface HumanRenderOptions { color: boolean; debug: boolean; now: Date }

function header(provider: ProviderReport, color: boolean): string {
  const name = provider.provider.toUpperCase();
  if (provider.status === "error") return colorText(name, color, "red", "bold") + colorText(" · error", color, "red");
  const availability = provider.availability;
  const state = availability.state === "limited"
    ? colorText(`LIMITED${availability.reason === null ? "" : ` (${availability.reason})`}`, color, "red", "bold")
    : availability.state === "unknown" ? colorText("status unknown", color, "yellow") : "available";
  const derived = availability.basis === "derived_from_limits" ? colorText(" (derived)", color, "dim") : "";
  return `${colorText(name, color, "bold")} · ${provider.account?.plan ?? "unknown plan"} · ${state}${derived}`;
}

function limitRow(limit: RateLimit, opts: HumanRenderOptions): string {
  const percent = `${formatPercent(limit.usedPercent).padStart(3)}%`;
  const styled = limit.usedPercent !== null && limit.usedPercent >= 90 ? colorText(percent, opts.color, "red")
    : limit.usedPercent !== null && limit.usedPercent >= 70 ? colorText(percent, opts.color, "yellow") : percent;
  const row = `  ${limit.label.padEnd(12)}${styled} used`;
  if (limit.resetsAt === null) return row.trimEnd();
  const reset = new Date(limit.resetsAt);
  return `${row}   ${formatLocalTime(reset, opts.now).padEnd(28)}${formatRelativeTime(reset, opts.now)}`;
}

function infoRow(label: string, text: string): string { return `  ${label.padEnd(13)}${text}`; }

function creditRow(credit: CreditBalance): string {
  if (credit.unit.type === "provider_credits") {
    const text = credit.unlimited === true ? "unlimited" : credit.balance === null ? "unknown" : `${Number(credit.balance).toFixed(2)} credits`;
    return infoRow(credit.label, text);
  }
  const enabled = credit.enabled === null ? "?" : credit.enabled ? "on" : "off";
  const reason = credit.disabledReason === null ? "" : ` (${credit.disabledReason})`;
  const amounts = credit.used === null || credit.limit === null ? "" : ` · ${credit.used} / ${credit.limit} ${credit.unit.currency}`;
  return infoRow(credit.label, `${enabled}${reason}${amounts}`);
}

function providerRows(provider: ProviderReport, opts: HumanRenderOptions): string[] {
  const rows = [header(provider, opts.color)];
  if (provider.status === "error") {
    for (const error of provider.errors) {
      rows.push(`  ${colorText(error.code, opts.color, "red")}  ${error.message}`);
      if (error.hint !== null) rows.push(`${" ".repeat(2 + error.code.length + 2)}→ ${error.hint}`);
    }
  } else {
    const rank = (limit: RateLimit): number => limit.id === "session" ? 0 : limit.id === "weekly" ? 1 : 2;
    for (const limit of [...provider.limits].sort((left, right) => rank(left) - rank(right))) rows.push(limitRow(limit, opts));
    for (const credit of provider.credits) rows.push(creditRow(credit));
    const resets = provider.resetCredits?.availableCount ?? 0;
    if (resets > 0) rows.push(infoRow("Resets", `${resets} reset credit${resets === 1 ? "" : "s"} available (never used by agent-usage)`));
    if (provider.analytics !== null) {
      const cutoff = new Date(opts.now);
      cutoff.setDate(cutoff.getDate() - 6);
      const firstDay = formatLocalDate(cutoff);
      const recent = provider.analytics.daily.filter((bucket) => bucket.date >= firstDay).reduce((total, bucket) => total + bucket.tokens, 0);
      rows.push(infoRow("Tokens", `lifetime ${formatCompact(provider.analytics.lifetimeTokens)} · peak day ${formatCompact(provider.analytics.peakDailyTokens)} · last 7 days ${formatCompact(recent)}`));
    }
    if (provider.status === "partial") for (const error of provider.errors) rows.push(colorText(`  ! ${error.code}  ${error.message}`, opts.color, "yellow"));
  }
  if (opts.debug) for (const warning of provider.warnings) rows.push(colorText(`  · ${warning.code}  ${warning.message}`, opts.color, "dim"));
  return rows;
}

/** Render normalized observations without I/O or mutation, in report order. */
export function renderHuman(report: UsageReport, opts: HumanRenderOptions): string {
  return `${report.providers.map((provider) => providerRows(provider, opts).join("\n").trimEnd()).join("\n\n")}\n`;
}
