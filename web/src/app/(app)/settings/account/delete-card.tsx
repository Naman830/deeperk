"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiPost, GENERIC_ERROR } from "@/lib/api-client";

/**
 * Docs/user/profile.md §2 — password + typed username, then a 30-day grace
 * window. The route only ever stamps deletionScheduledAt; the row is never
 * hard-deleted. There is no Deactivate button on purpose: §7 keeps them
 * separate so nobody destroys an account they only meant to hide.
 */
export function DeleteCard({ username, deletionScheduledAt }: { username: string; deletionScheduledAt: Date | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmUsername, setConfirmUsername] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // The dialog closes before the refresh resolves, so the card trigger is the only
  // surface left to show that work is still in flight.
  const [refreshing, startRefresh] = useTransition();
  const [scheduledAt, setScheduledAt] = useState<Date | null>(deletionScheduledAt);

  const matches = confirmUsername.trim().toLowerCase() === username.toLowerCase();

  async function handleDelete(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    const res = await apiPost<{ deletionScheduledAt?: string }>("/api/me/delete", { password, confirmUsername });
    setBusy(false);

    if (!res.ok) {
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }

    setScheduledAt(res.data.deletionScheduledAt ? new Date(res.data.deletionScheduledAt) : null);
    setOpen(false);
    setPassword("");
    setConfirmUsername("");
    toast.info("Account scheduled for deletion.");
    startRefresh(() => router.refresh());
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">Delete account</CardTitle>
        <CardDescription>
          {scheduledAt
            ? `Scheduled for ${new Date(scheduledAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}. Signing in before then cancels it automatically.`
            : "Your account is hidden immediately and permanently removed after 30 days. Signing in during that window cancels it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="destructive" size="lg" onClick={() => setOpen(true)} disabled={refreshing || Boolean(scheduledAt)}>
          {scheduledAt ? "Deletion scheduled" : "Delete my account"}
        </Button>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleDelete} className="contents">
            <DialogHeader>
              <DialogTitle>Delete your account?</DialogTitle>
              <DialogDescription>
                This hides your profile now and deletes it in 30 days. Your messages stay, attributed to a deleted user.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delete-password">Password</Label>
                <Input
                  id="delete-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="delete-username">
                  Type <span className="font-mono">{username}</span> to confirm
                </Label>
                <Input
                  id="delete-username"
                  autoComplete="off"
                  value={confirmUsername}
                  onChange={(event) => setConfirmUsername(event.target.value)}
                  className="h-9"
                />
              </div>
              {error && <p className="text-destructive text-sm">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={busy || !password || !matches}>
                {busy ? "Scheduling…" : "Delete account"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
