"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { requestPasswordResetOtp, resetPasswordWithOtp } from "@/lib/auth/client";
import { AuthFormField } from "@/components/features/auth/auth-form-field";
import { emailSchema, otpSchema, passwordSchema, passwordRequirements, getPasswordSubmitError } from "@/lib/validation/signup";
import { FormError } from "@/components/features/shell/form-error";
import { Button } from "@/components/ui/button";

type Step = "email" | "reset";

// Docs/user/auth.md §2 "Forgot password" — the request step always shows the
// same non-committal message regardless of whether the account exists
// (Better Auth's /email-otp/request-password-reset already behaves this way
// by default — verified against its installed source).
export function ForgotPasswordForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setSubmitting(true);
    await requestPasswordResetOtp({ email: parsed.data });
    setSubmitting(false);
    setEmail(parsed.data);
    setStep("reset");
    toast.info("If that email has an account, a reset code was sent to it.");
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);

    const otpParsed = otpSchema.safeParse(otp);
    if (!otpParsed.success) {
      setError(otpParsed.error.issues[0]?.message);
      return;
    }
    const passwordParsed = passwordSchema.safeParse(password);
    if (!passwordParsed.success) {
      setError(getPasswordSubmitError(password));
      return;
    }

    setSubmitting(true);
    const { error: resetError } = await resetPasswordWithOtp({
      email,
      otp: otpParsed.data,
      password: passwordParsed.data,
    });
    setSubmitting(false);

    if (resetError) {
      setError("That code is incorrect or has expired.");
      return;
    }

    toast.success("Password reset. Please log in.");
    router.push("/login");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reset password</h1>
        <p className="text-muted-foreground text-sm">
          {step === "email"
            ? "Enter your email and we'll send a reset code if an account exists."
            : `Enter the code sent to ${email} and choose a new password.`}
        </p>
      </div>

      {step === "email" ? (
        <form onSubmit={handleRequestOtp} className="flex flex-col gap-4">
          <AuthFormField
            label="Email"
            name="email"
            type="email"
            value={email}
            onChange={setEmail}
            autoFocus
            autoComplete="email"
          />
          <FormError>{error}</FormError>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Sending…" : "Send reset code"}
          </Button>
        </form>
      ) : (
        <form onSubmit={handleReset} className="flex flex-col gap-4">
          <AuthFormField label={`Code sent to ${email}`} name="otp" value={otp} onChange={setOtp} autoFocus />
          <AuthFormField
            label="New password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            showPasswordToggle
            requirements={{ rules: passwordRequirements }}
          />
          <FormError>{error}</FormError>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Resetting…" : "Reset password"}
          </Button>
        </form>
      )}

      <Link href="/login" className="text-muted-foreground text-sm hover:text-foreground">
        Back to login
      </Link>
    </main>
  );
}
