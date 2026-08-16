"use client";

import { useState } from "react";
import { toast } from "react-toastify";
import { authClient } from "@/lib/auth/client";
import { AuthFormField } from "@/components/features/auth/auth-form-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPasswordSubmitError, passwordRequirements } from "@/lib/validation/signup";
import { FormError } from "@/components/features/shell/form-error";

// Better Auth's core /change-password, reached through the /api/auth catch-all —
// Docs/user/profile.md never specs an app-side route for this, so none is invented.
export function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    const passwordError = getPasswordSubmitError(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setSaving(true);
    const { error: changeError } = await authClient.changePassword({
      currentPassword,
      newPassword,
      // Changing a password should sign every other device out.
      revokeOtherSessions: true,
    });
    setSaving(false);

    if (changeError) {
      setError(changeError.status === 429 ? "Too many attempts. Please try again later." : "Your current password is incorrect.");
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    toast.success("Password changed. Other sessions have been signed out.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing your password signs you out everywhere else.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <AuthFormField
            label="Current password"
            name="currentPassword"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            showPasswordToggle
          />
          <AuthFormField
            label="New password"
            name="newPassword"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            autoComplete="new-password"
            showPasswordToggle
            requirements={{ rules: passwordRequirements }}
          />
          <AuthFormField
            label="Confirm new password"
            name="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            autoComplete="new-password"
          />

          <FormError>{error}</FormError>

          <Button type="submit" size="lg" className="self-start" disabled={saving || !currentPassword || !newPassword}>
            {saving ? "Saving…" : "Change password"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
