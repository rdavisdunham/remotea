# Redaction: the shared secret patterns

remotea and Eridani redact the same things the same way. This page is the canonical copy of the list.

- remotea compiles it in `remote-server/src/collector/redact.ts` (`SECRET_PATTERNS`).
- Eridani compiles it in `apps/api/jarvis/redaction.py`, which the Python session collector imports as well.

A test on each side checks its list against this page and these vectors. To change the list, change all three in the same release.

## Where it applies

On the host (remotea), it runs before anything leaves the machine:

- session reports (`clip`/`redact`, unchanged since the collector port);
- captured turns: the final response and the prompt;
- verify output tails and verify errors (stage F; the tail is redacted first and then cut to its 4,000-character limit);
- question items: text, header, choice labels and descriptions. The answer echo and the `needs_you` reason are redacted too (stage F). The held copy used to match an answer keeps the exact text.

On Eridani (stage F), every host-supplied free-text field is redacted again on ingestion.

## The patterns

The patterns are joined into one alternation, `(p1|p2|…)`, and every match is replaced with `[redacted]`. The rules for writing them:

- **No inline flags.** JavaScript and Python disagree on `(?i)`, so the patterns spell case out with character classes.
- **End of input is written `(?![\s\S])`.** It means the same thing in both languages. Python's `$` would also match before a trailing newline.
- **Numbers and strings only.** No pattern depends on Unicode case folding.

```text
sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}
gh[pousr]_[A-Za-z0-9]{30,}
github_pat_[A-Za-z0-9_]{30,}
AKIA[0-9A-Z]{16}
xox[abpr]-[A-Za-z0-9-]{10,}
eri_bot_[A-Za-z0-9_-]{20,}
lin_api_[A-Za-z0-9]{20,}
[Bb][Ee][Aa][Rr][Ee][Rr]\s+[A-Za-z0-9._~+/=-]{20,}
eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|(?![\s\S]))
://[^/\s:@]+:[^/\s@]+@
(?:[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Tt][Oo][Kk][Ee][Nn]|[Aa][Pp][Ii]_[Kk][Ee][Yy])\s*[=:]\s*\S{8,}
```

What the stage F additions cover:

- **JWTs:** three base64url segments, the first starting `eyJ`.
- **PEM private keys:** the whole block, including a block that the tail limit cut before its `END` line.
- **Credentials in a URL:** `scheme://user:pass@`. The scheme name stays and the user, password and `@` go. A `host:port/…@` is not a credential, so it is left alone.
- **`password` / `secret` / `token` / `api_key` assignments:** `=` or `:` followed by eight or more non-space characters. `token=short` and `max_tokens: 4096` stay, on purpose.

## Test vectors

The table is input → output, as JSON strings. In the table, `|` is escaped as `\|`.

| input | output |
|---|---|
| "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U ok" | "auth [redacted] ok" |
| "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter" | "[redacted]\nafter" |
| "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\ntruncat" | "[redacted]" |
| "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----" | "[redacted]" |
| "postgres://app:s3cr3t-pw@db.internal:5432/x" | "postgres[redacted]db.internal:5432/x" |
| "https://host:8443/path@x" | "https://host:8443/path@x" |
| "PASSWORD=hunter2hunter2 next" | "[redacted] next" |
| "api_key: \"abcd1234efgh\"" | "[redacted]" |
| "Secret = 12345678" | "[redacted]" |
| "token=short" | "token=short" |
| "max_tokens: 4096" | "max_tokens: 4096" |
| "key sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaa" | "key [redacted]" |
