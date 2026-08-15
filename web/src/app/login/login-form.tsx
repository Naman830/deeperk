"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { signIn } from "@/lib/auth-client";
import { AuthFormField } from "@/components/auth-form-field";
import { loginSchema } from "@/lib/validation/login";

// Docs/user/auth.md §2 "Login" — any failure (wrong email OR wrong password)
// shows the exact same generic error, so account existence is never leaked.
// (Better Auth's own /sign-in/email already returns one identical error code
// for every failure reason — verified against its installed source — so no
// extra normalization is needed here beyond always showing this one string.)
const GENERIC_LOGIN_ERROR = "Incorrect email or password.";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_LOGIN_ERROR);
      return;
    }

    setSubmitting(true);
    const { error: signInError } = await signIn.email({
      email: parsed.data.email,
      password: parsed.data.password,
    });
    setSubmitting(false);

    if (signInError) {
      if (signInError.status === 429) {
        setError("Too many attempts. Please try again later.");
      } else {
        setError(GENERIC_LOGIN_ERROR);
      }
      return;
    }

    toast.success("Welcome back!");
    router.push("/");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
        <p className="text-muted text-sm">Welcome back to ChatSphere.</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <AuthFormField
          label="Email"
          name="email"
          type="email"
          value={email}
          onChange={setEmail}
          autoFocus
          autoComplete="email"
        />
        <AuthFormField
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>

      <div className="flex justify-between text-sm">
        <Link href="/login/forgot-password" className="text-muted hover:text-foreground">
          Forgot password?
        </Link>
        <Link href="/signup" className="text-muted hover:text-foreground">
          Create an account
        </Link>
      </div>
    </main>
  );
}
