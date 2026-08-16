"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { isUsernameAvailable } from "@/lib/auth/client";
import { AuthFormField } from "@/components/auth-form-field";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  emailSchema,
  otpSchema,
  firstNameSchema,
  lastNameSchema,
  usernameSchema,
  toCanonicalUsername,
  getUsernameSubmitError,
  birthDateSchema,
  passwordSchema,
  passwordRequirements,
  getPasswordSubmitError,
} from "@/lib/validation/signup";
import { usernameRequirements } from "@/lib/validation/username";

type Step = "email" | "otp" | "firstName" | "lastName" | "username" | "birthDate" | "password";

const STEP_ORDER: Step[] = ["email", "otp", "firstName", "lastName", "username", "birthDate", "password"];

type UsernameCheckStatus = "idle" | "checking" | "available" | "taken" | "error";

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="text-muted self-start text-sm hover:text-foreground">
      ← Back
    </button>
  );
}

export function SignupForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [password, setPassword] = useState("");

  // True once the current email's OTP has been verified — reset whenever a
  // fresh code goes out, so re-visiting `otp` after editing `email` is
  // structurally forced (STEP_ORDER only ever moves one step at a time).
  const [otpVerified, setOtpVerified] = useState(false);

  // Only the outcome of the last-resolved check is kept in state; "checking"
  // itself is derived (no cached result yet for the current value) rather
  // than setState'd, so the effect below never setStates outside a callback.
  const [usernameCheckedValue, setUsernameCheckedValue] = useState("");
  const [usernameCheckResult, setUsernameCheckResult] = useState<"available" | "taken" | "error" | null>(null);
  const debouncedUsername = useDebouncedValue(username, 400);

  const stepIndex = STEP_ORDER.indexOf(step);

  function goNext() {
    setError(undefined);
    setStep(STEP_ORDER[stepIndex + 1]);
  }

  function goBack() {
    setError(undefined);
    const prevStep = STEP_ORDER[stepIndex - 1];
    // A code sent for the email you're about to edit shouldn't linger.
    if (step === "otp" && prevStep === "email") setOtp("");
    setStep(prevStep);
  }

  const usernameShapeValid = usernameSchema.safeParse(debouncedUsername).success;
  const hasCachedResult = usernameShapeValid && usernameCheckedValue === toCanonicalUsername(debouncedUsername);
  const displayedUsernameStatus: UsernameCheckStatus = !usernameShapeValid
    ? "idle"
    : hasCachedResult
      ? (usernameCheckResult ?? "checking")
      : "checking";

  // Live username availability — fires ~400ms after typing settles, guarded
  // against out-of-order responses from fast typers via the `ignore` flag.
  useEffect(() => {
    const parsed = usernameSchema.safeParse(debouncedUsername);
    if (!parsed.success) return;
    let ignore = false;
    isUsernameAvailable({ username: parsed.data })
      .then(({ data }) => {
        if (ignore) return;
        setUsernameCheckedValue(toCanonicalUsername(parsed.data));
        setUsernameCheckResult(data?.available ? "available" : "taken");
      })
      .catch(() => {
        if (ignore) return;
        setUsernameCheckedValue(toCanonicalUsername(parsed.data));
        setUsernameCheckResult("error");
      });
    return () => {
      ignore = true;
    };
  }, [debouncedUsername]);

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    const check = await postJson("/api/signup/check-email", { email: parsed.data });
    if (!check.ok) {
      setSubmitting(false);
      setError(check.data.error ?? "Something went wrong.");
      return;
    }
    if (check.data.exists) {
      setSubmitting(false);
      toast.info("That email already has an account. Please log in instead.");
      router.push("/login");
      return;
    }
    const sent = await postJson("/api/signup/send-otp", { email: parsed.data });
    setSubmitting(false);
    if (!sent.ok) {
      setError(sent.data.error ?? "Couldn't send the code. Please try again.");
      return;
    }
    toast.info(otpVerified ? "We sent a new code to your email." : "We sent a 6-digit code to your email.");
    setOtpVerified(false);
    setEmail(parsed.data);
    goNext();
  }

  async function handleResendOtp() {
    setSubmitting(true);
    const sent = await postJson("/api/signup/send-otp", { email });
    setSubmitting(false);
    if (!sent.ok) {
      setError(sent.data.error ?? "Couldn't resend the code.");
      return;
    }
    toast.info("Sent a new code.");
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = otpSchema.safeParse(otp);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    const verify = await postJson("/api/signup/verify-otp", { email, otp: parsed.data });
    setSubmitting(false);
    if (!verify.ok) {
      setError(verify.data.error ?? "Incorrect code.");
      return;
    }
    setOtpVerified(true);
    goNext();
  }

  function handleFirstNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = firstNameSchema.safeParse(firstName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setFirstName(parsed.data);
    goNext();
  }

  function handleLastNameSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = lastNameSchema.safeParse(lastName);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setLastName(parsed.data ?? "");
    goNext();
  }

  async function handleUsernameSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) {
      setError(getUsernameSubmitError(username));
      return;
    }
    // Skip the redundant network call if the live check already confirmed
    // this exact value is available.
    const alreadyConfirmed =
      usernameCheckResult === "available" && usernameCheckedValue === toCanonicalUsername(parsed.data);
    if (alreadyConfirmed) {
      setUsername(parsed.data);
      goNext();
      return;
    }
    setSubmitting(true);
    const { data: availability } = await isUsernameAvailable({ username: parsed.data });
    setSubmitting(false);
    if (!availability?.available) {
      setError("That username is taken.");
      return;
    }
    setUsername(parsed.data);
    goNext();
  }

  function handleBirthDateSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = birthDateSchema.safeParse(birthDate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setBirthDate(parsed.data);
    goNext();
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) {
      setError(getPasswordSubmitError(password));
      return;
    }
    setSubmitting(true);
    const complete = await postJson("/api/signup/complete", {
      firstName,
      lastName,
      username,
      birthDate,
      password: parsed.data,
    });
    setSubmitting(false);
    if (!complete.ok) {
      setError(complete.data.error ?? "Something went wrong. Please try again.");
      return;
    }
    toast.success("Welcome to ChatSphere!");
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
        <p className="text-muted text-sm">Step {stepIndex + 1} of {STEP_ORDER.length}</p>
        <div className="bg-border mt-2 h-1 w-full overflow-hidden rounded-full">
          <div
            className="h-full rounded-full bg-foreground transition-all"
            style={{ width: `${((stepIndex + 1) / STEP_ORDER.length) * 100}%` }}
          />
        </div>
      </div>

      {step === "email" && (
        <form onSubmit={handleEmailSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Email" name="email" type="email" value={email} onChange={setEmail} autoFocus autoComplete="email" />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
            {submitting ? "Sending code…" : "Continue"}
          </button>
        </form>
      )}

      {step === "otp" && (
        <form onSubmit={handleOtpSubmit} className="flex flex-col gap-4">
          <AuthFormField label={`Code sent to ${email}`} name="otp" value={otp} onChange={setOtp} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
            {submitting ? "Verifying…" : "Verify"}
          </button>
          <button type="button" onClick={handleResendOtp} className="text-muted text-sm hover:text-foreground">
            Resend code
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      {step === "firstName" && (
        <form onSubmit={handleFirstNameSubmit} className="flex flex-col gap-4">
          <AuthFormField label="First name" name="firstName" value={firstName} onChange={setFirstName} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      {step === "lastName" && (
        <form onSubmit={handleLastNameSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Last name (optional)" name="lastName" value={lastName} onChange={setLastName} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      {step === "username" && (
        <form onSubmit={handleUsernameSubmit} className="flex flex-col gap-4">
          <AuthFormField
            label="Username"
            name="username"
            value={username}
            onChange={setUsername}
            autoFocus
            requirements={{ rules: usernameRequirements }}
          />
          {displayedUsernameStatus === "checking" && <p className="text-muted text-sm">Checking availability…</p>}
          {displayedUsernameStatus === "available" && <p className="text-sm text-green-500">✓ Available</p>}
          {displayedUsernameStatus === "taken" && <p className="text-sm text-red-500">✗ Already taken</p>}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={submitting || displayedUsernameStatus === "checking"}
            className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {submitting ? "Checking…" : "Continue"}
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      {step === "birthDate" && (
        <form onSubmit={handleBirthDateSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Date of birth" name="birthDate" type="date" value={birthDate} onChange={setBirthDate} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      {step === "password" && (
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
          <AuthFormField
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
            autoComplete="new-password"
            showPasswordToggle
            requirements={{ rules: passwordRequirements }}
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
            {submitting ? "Creating account…" : "Create account"}
          </button>
          <BackButton onClick={goBack} />
        </form>
      )}

      <Link href="/login" className="text-muted text-sm hover:text-foreground">
        Already have an account? Log in
      </Link>
    </main>
  );
}
