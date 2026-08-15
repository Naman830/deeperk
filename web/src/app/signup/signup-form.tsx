"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { isUsernameAvailable } from "@/lib/auth-client";
import { AuthFormField } from "@/components/auth-form-field";
import {
  emailSchema,
  otpSchema,
  firstNameSchema,
  lastNameSchema,
  usernameSchema,
  birthDateSchema,
  passwordSchema,
} from "@/lib/validation/signup";

type Step = "email" | "otp" | "firstName" | "lastName" | "username" | "birthDate" | "password";

const STEP_ORDER: Step[] = ["email", "otp", "firstName", "lastName", "username", "birthDate", "password"];

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
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

  function goNext() {
    const i = STEP_ORDER.indexOf(step);
    setError(undefined);
    setStep(STEP_ORDER[i + 1]);
  }

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
    setEmail(parsed.data);
    toast.info("We sent a 6-digit code to your email.");
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
      setError(parsed.error.issues[0]?.message);
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
      setError(parsed.error.issues[0]?.message);
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
        <p className="text-muted text-sm">Step {STEP_ORDER.indexOf(step) + 1} of {STEP_ORDER.length}</p>
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
        </form>
      )}

      {step === "firstName" && (
        <form onSubmit={handleFirstNameSubmit} className="flex flex-col gap-4">
          <AuthFormField label="First name" name="firstName" value={firstName} onChange={setFirstName} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
        </form>
      )}

      {step === "lastName" && (
        <form onSubmit={handleLastNameSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Last name (optional)" name="lastName" value={lastName} onChange={setLastName} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
        </form>
      )}

      {step === "username" && (
        <form onSubmit={handleUsernameSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Username" name="username" value={username} onChange={setUsername} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
            {submitting ? "Checking…" : "Continue"}
          </button>
        </form>
      )}

      {step === "birthDate" && (
        <form onSubmit={handleBirthDateSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Date of birth" name="birthDate" type="date" value={birthDate} onChange={setBirthDate} autoFocus />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            Continue
          </button>
        </form>
      )}

      {step === "password" && (
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
          <AuthFormField label="Password" name="password" type="password" value={password} onChange={setPassword} autoFocus autoComplete="new-password" />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button type="submit" disabled={submitting} className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>
      )}

      <Link href="/login" className="text-muted text-sm hover:text-foreground">
        Already have an account? Log in
      </Link>
    </main>
  );
}
