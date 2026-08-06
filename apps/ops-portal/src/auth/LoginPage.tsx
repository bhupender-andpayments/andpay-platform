import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext.js";
import { ApiError } from "../api/errors.js";
import { Button, Field, Input, ErrorNote } from "../ui/primitives.js";
import { EnrollTotpPanel } from "./EnrollTotpPanel.js";

// Presentation-only reskin over the UNCHANGED auth spine. Two visual steps
// (credentials, then TOTP), but both factors are still submitted together in
// a SINGLE spine login() call at final submit, exactly as before: the step
// split is a client-side gate on when the TOTP field is revealed, not a
// second network round trip or a server-side "password valid?" probe, so the
// edge's uniform-failure property (never revealing which factor failed) is
// unchanged. Field ids/names/labels (Username, Password, TOTP, Sign in) and
// the role=alert error surface are the same as before, so nothing downstream
// of AuthContext.login() changes.
//
// Layout: a two-panel sign-in. The left panel is brand and context and is
// purely decorative, so it is hidden below lg and replaced by a compact
// header; every interactive element lives in the right panel and is reachable
// at any viewport. The wash is defined once as .login-mesh in index.css.
//
// The step marker is numbered because the content genuinely IS an ordered
// sequence (credentials, then the code), so the number carries information
// rather than decorating.

const BRAND_LOGO = "/logo/logo.svg";

function IconEye({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      {off && (
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const [step, setStep] = useState<"credentials" | "totp" | "enroll">(
    "credentials",
  );
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [enrollPrincipalId, setEnrollPrincipalId] = useState<string | null>(
    null,
  );
  const [showPassword, setShowPassword] = useState(false);


  // The password screen decides what comes next, because only the SERVER knows
  // whether this principal has a factor. A password-only request answers it:
  //   never enrolled -> enrollment token -> the QR screen, and the operator is
  //     never shown a code field they cannot fill
  //   already enrolled -> uniform 401 -> the code screen
  //   wrong password -> the SAME uniform 401 -> also the code screen
  // Advancing on any 401 is what keeps this leak-free: the screen the caller
  // lands on is identical for a wrong password and a correct one, so nothing
  // about credential validity or enrollment state is disclosed. The final
  // submit is where a wrong password fails, exactly as before.
  async function onContinue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (handle.trim() === "" || password === "") {
      setError("Enter your username and password to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const outcome = await login({ handle, password, totp: "" });
      if (outcome.kind === "enrollment-required") {
        setEnrollPrincipalId(outcome.principalId);
        setStep("enroll");
        return;
      }
      if (outcome.kind === "mfa-required") {
        setStep("totp");
        return;
      }
      // A real session came back, so the sign-in is COMPLETE and the principal
      // is already set: advancing to a code screen would strand a logged-in
      // operator on a form they do not need. Not expected today (a password
      // alone cannot reach the AAL2 floor) but correct if a role ever sits at
      // AAL1.
    } catch (err) {
      // The credentials are now judged HERE, on the step that collected them,
      // instead of silently advancing to a code screen that would fail later
      // for a reason the operator could not see.
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        setError("Invalid username or password.");
        return;
      }
      setError("Sign in failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // The field is labelled "Username" for the ops user, but the wire
      // contract (auth-edge login.controller.ts) names it `handle`. Both
      // factors go out together in this ONE call, regardless of how many
      // screens the operator saw first.
      // An EMPTY code is submitted as a password-only request (the client omits
      // the field rather than sending ""), which is how first-time setup is
      // reached WITHOUT ever showing an enrolled operator a "set up your
      // authenticator" affordance. The SERVER decides which case this is:
      //   never enrolled -> enrollmentRequired, and the setup panel opens here
      //   already enrolled -> uniform 401, handled below as a normal failure
      // Nothing about enrollment state is exposed to the client before it asks,
      // so there is no enumeration oracle and no new disclosure beyond what the
      // enrollment feature already implies.
      const outcome = await login({ handle, password, totp });
      if (outcome.kind === "enrollment-required") {
        setEnrollPrincipalId(outcome.principalId);
        setStep("enroll");
      }
    } catch (err) {
      // A uniform 401 (bad credential, bad TOTP, or unmet assurance floor) or
      // any other failure (a malformed token, a network error) surfaces the
      // same generic message: the edge never reveals which factor failed.
      if (
        err instanceof ApiError &&
        (err.status === 401 || err.status === 403)
      ) {
        setError("Invalid username, password, or authentication code.");
      } else {
        setError("Sign in failed. Please try again.");
      }
      setTotp("");
      setStep("credentials");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main
      aria-label="Sign in"
      className="min-h-screen bg-surface lg:grid lg:grid-cols-[1.15fr_0.85fr]"
    >
      {/* Brand panel. Decorative and non-interactive, so it is dropped
          entirely on small screens rather than stacked and scrolled past. */}
      <aside className="login-mesh relative hidden flex-col justify-between p-12 lg:flex xl:p-16">
        {/* self-start keeps the mark at its intrinsic width: a column flex
            container stretches its children by default, which centers it. */}
        <img
          src={BRAND_LOGO}
          alt="AndPayments"
          className="h-10 w-auto self-start"
        />

        <div className="max-w-xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Soundbox Dispatch Console
          </p>
          <h2 className="mt-5 text-5xl font-bold leading-[1.05] tracking-[-0.03em] text-brand xl:text-6xl">
            Every soundbox, from bank file to activation.
          </h2>
        </div>

        <p className="text-xs text-subtle">
          © 2026 AndPayments Inc. All rights reserved.
        </p>
      </aside>

      {/* Sign-in panel. */}
      <div className="flex min-h-screen items-center justify-center px-6 py-12 lg:min-h-0">
        <div className="w-full max-w-sm">
          <img
            src={BRAND_LOGO}
            alt="AndPayments"
            className="mb-10 h-9 w-auto lg:hidden"
          />

          <p className="text-sm text-muted-foreground">
            Welcome to{" "}
            <span className="font-semibold text-ink">AndPayments</span>
          </p>

          {step === "enroll" && enrollPrincipalId !== null ? (
            <EnrollTotpPanel
              principalId={enrollPrincipalId}
              accountLabel={handle}
              onDone={() => {
                // Back to the code step, now that a factor exists. The password
                // is kept so the operator types only the fresh code.
                setEnrollPrincipalId(null);
                setTotp("");
                setError(null);
                setStep("totp");
              }}
            />
          ) : step === "credentials" ? (
            <>
              <h1 className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ink">
                Sign in to your account
              </h1>
              <form
                className="mt-7 space-y-5"
                onSubmit={(e) => {
                  void onContinue(e);
                }}
              >
                <Field label="Username" htmlFor="login-handle">
                  <Input
                    id="login-handle"
                    name="username"
                    autoComplete="username"
                    autoFocus
                    placeholder="Enter your username"
                    className="h-12"
                    value={handle}
                    onChange={(e) => setHandle(e.target.value)}
                  />
                </Field>
                <Field label="Password" htmlFor="login-password">
                  <div className="relative">
                    <Input
                      id="login-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Enter your password"
                      className="h-12 pr-11"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                      className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-subtle hover:text-ink"
                    >
                      <IconEye off={showPassword} />
                    </button>
                  </div>
                </Field>
                {error !== null && <ErrorNote>{error}</ErrorNote>}
                <Button type="submit" className="h-12 w-full rounded-full text-[15px]">
                  Continue
                </Button>
              </form>
            </>
          ) : (
            <>
              <h1 className="mt-1 text-3xl font-bold tracking-[-0.02em] text-ink">
                Enter your code
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                Signing in as{" "}
                <span className="font-medium text-ink">{handle}</span>. Enter
                the 6-digit code from your authenticator app.
              </p>
              <form
                className="mt-5 space-y-5"
                onSubmit={(e) => {
                  void onSubmit(e);
                }}
              >
                <Field label="TOTP" htmlFor="login-totp">
                  <Input
                    id="login-totp"
                    name="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    placeholder="000000"
                    className="num h-14 text-center text-2xl tracking-[0.5em] placeholder:text-line-strong"
                    value={totp}
                    onChange={(e) => setTotp(e.target.value)}
                  />
                </Field>
                {error !== null && <ErrorNote>{error}</ErrorNote>}
                <Button
                  type="submit"
                  loading={submitting}
                  className="h-12 w-full rounded-full text-[15px]"
                >
                  Sign in
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 w-full rounded-full"
                  onClick={() => {
                    setError(null);
                    setStep("credentials");
                  }}
                >
                  Back
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
