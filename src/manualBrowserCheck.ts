import { CodexProError } from "./guard.js";

export type ManualCheckKind = "verification" | "authentication";

export class ManualBrowserCheckError extends CodexProError {
  readonly code = "MANUAL_BROWSER_CHECK_REQUIRED";

  constructor(readonly kind: ManualCheckKind) {
    super(kind === "verification"
      ? "ChatGPT requires a manual browser verification (for example Cloudflare Turnstile). Press b to open the dedicated CodexPro browser, complete the check yourself, then call subagent_resume."
      : "ChatGPT authentication is required. Press b to open the dedicated CodexPro browser, sign in yourself, then call subagent_resume.");
  }
}
