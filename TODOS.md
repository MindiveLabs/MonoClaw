# TODOS

## macOS sandbox deprecation

**Replace `sandbox-exec` with a non-deprecated macOS sandboxing mechanism.**

`sandbox-exec` is officially deprecated by Apple and may be removed in a future macOS release. MonoClaw currently uses it as the primary isolation primitive on macOS.

**Why:** Without a replacement, MonoClaw's macOS isolation story fails on whatever version Apple drops the API.

**Pros:** Future-proof. Modern Endpoint Security framework or Landlock (Linux) offer robust isolation.

**Cons:** Significant complexity. Endpoint Security requires a system extension (code-signing, notarization). Landlock is Linux-only. No drop-in replacement for Seatbelt exists yet.

**Context:** `sandbox-exec` currently works on macOS 15.x (confirmed). The deprecation warning exists in Apple docs but removal timeline is unknown. MonoClaw documents this limitation in README. Re-evaluate when target users report issues or when Apple announces a removal date.

**Where to start:** `src/sandbox.ts` — watch Apple release notes; evaluate Landlock for the Linux path when that becomes a priority.

**Depends on:** macOS version landscape among MonoClaw users.
