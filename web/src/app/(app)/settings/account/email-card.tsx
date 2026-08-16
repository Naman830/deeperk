"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiPost, GENERIC_ERROR } from "@/lib/api-client";

type Step = "closed" | "credentials" | "otp";

/**
 * Docs/user/profile.md §2 — password, then an OTP sent to the NEW address.
 * Deliberately not Better Auth's own /change-email (link-token based, not OTP).
 */
export function EmailCard({ email }: { email: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("closed");

  const [password, setPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep("closed");
    setPassword("");
    setNewEmail("");
    setOtp("");
    setError(undefined);
  }

  async function startChange(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    const res = await apiPost("/api/me/email/start", { password, newEmail });
    setBusy(false);

    if (!res.ok) {
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }
    // Always advance: the route answers success even when the address is already
    // taken, so that a failure here can't confirm an account exists (§5).
    setPassword("");
    setStep("otp");
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    const res = await apiPost<{ attemptsRemaining?: number }>("/api/me/email/verify", { otp });
    setBusy(false);

    if (!res.ok) {
      const remaining = res.data.attemptsRemaining;
      setError(
        remaining !== undefined
          ? `${res.data.error ?? "Incorrect code."} ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
          : (res.data.error ?? GENERIC_ERROR),
      );
      // A burned or expired pending change means starting over from the password.
      if (remaining === 0) setStep("credentials");
      setOtp("");
      return;
    }

    toast.success("Email updated. Other sessions have been signed out.");
    reset();
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>Changing this needs your password and a code sent to the new address.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">{email}</span>
        <Button variant="outline" size="lg" onClick={() => setStep("credentials")}>
          Change email
        </Button>
      </CardContent>

      <Dialog open={step !== "closed"} onOpenChange={(open) => !open && reset()}>
        <DialogContent>
          {step === "credentials" ? (
            <form onSubmit={startChange} className="contents">
              <DialogHeader>
                <DialogTitle>Change your email</DialogTitle>
                <DialogDescription>We&apos;ll send a 6-digit code to the new address to confirm it.</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email-change-password">Current password</Label>
                  <Input
                    id="email-change-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email-change-new">New email</Label>
                  <Input
                    id="email-change-new"
                    type="email"
                    autoComplete="email"
                    value={newEmail}
                    onChange={(event) => setNewEmail(event.target.value)}
                    className="h-9"
                  />
                </div>
                {error && <p className="text-destructive text-sm">{error}</p>}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !password || !newEmail}>
                  {busy ? "Sending…" : "Send code"}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <form onSubmit={verify} className="contents">
              <DialogHeader>
                <DialogTitle>Enter the code</DialogTitle>
                <DialogDescription>We sent a 6-digit code to {newEmail}. It expires in 5 minutes.</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email-change-otp">Verification code</Label>
                  <Input
                    id="email-change-otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otp}
                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                    className="h-9 tracking-[0.4em]"
                  />
                </div>
                {error && <p className="text-destructive text-sm">{error}</p>}
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setStep("credentials")} disabled={busy}>
                  Start over
                </Button>
                <Button type="submit" disabled={busy || otp.length !== 6}>
                  {busy ? "Verifying…" : "Confirm email"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
