import { expect, test } from "vitest";
import { redactText } from "../../src/redact.js";

test.each([
  ["key sk-1234567890abcdef", "key [REDACTED]"],
  ["key sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE", "key [REDACTED]"],
  ["JWT eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE", "JWT [REDACTED]"],
  ["JWT eyJhbGciOiJIUzI1NiJ9.FAKE", "JWT [REDACTED]"],
  ["auth Bearer short-secret", "auth [REDACTED]"],
  ["auth bEaReR\tshort-secret", "auth [REDACTED]"],
  ["user+tag@example.invalid", "[REDACTED]"],
  ["token " + "a".repeat(40), "token [REDACTED]"],
  ["token " + "a_9-".repeat(20), "token [REDACTED]"],
])("redacts %s", (input, expected) => expect(redactText(input)).toBe(expected));

test("redacts all occurrences and mixed patterns in multiline diagnostics", () => {
  const sample = "Bearer eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE\nuser@example.invalid sk-1234567890abcdef\n" + "a".repeat(60);
  expect(redactText(sample)).toBe("[REDACTED]\n[REDACTED] [REDACTED]\n[REDACTED]");
});

test.each(["", "spawn codex app-server; id 3; exit 0; took 700 ms", "Weekly 41% used; 318.2716000000 credits", "sk-short", "a".repeat(39)])(
  "leaves ordinary text unchanged: %s", (input) => expect(redactText(input)).toBe(input),
);

test("redaction is idempotent", () => {
  const redacted = redactText("Bearer secret user@example.invalid sk-1234567890abcdef");
  expect(redactText(redacted)).toBe(redacted);
});
