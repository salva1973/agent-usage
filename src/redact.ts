/** Replace credential-like substrings and email addresses in outgoing text. */
export function redactText(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[REDACTED]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED]");
}
