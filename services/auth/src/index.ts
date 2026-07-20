// The Auth platform service (handoff spec 04). The sole holder of the ES256
// signing key, the 5c pepper, and the D121 stores; all Decision-3 token and
// class-6 credential issuance and lifecycle live here. Modules are added task by
// task; this entry re-exports the public surface as it grows.

// The Decision-3 token issuer identity (iss claim), verified locally by every
// consumer against the JWKS (16.3, T4).
export const AUTH_ISS = "andpay-auth";

export * from "./ports/kms-signing.js";
export * from "./ports/pepper.js";
export * from "./ports/mfa.js";
export * from "./config/index.js";
export * from "./issue.js";
export * from "./assurance.js";
export * from "./stepup.js";
export * from "./refresh.js";
export * from "./login.js";
export * from "./secret.js";
export * from "./events.js";
export * from "./denylist.js";
export * from "./credentials.js";
export * from "./audit.js";
export * from "./authorize.js";
export * from "./redact.js";
export * from "./identity-seam.js";
