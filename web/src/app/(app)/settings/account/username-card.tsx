"use client";

import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { isUsernameAvailable } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiPatch, GENERIC_ERROR } from "@/lib/api-client";
import { getUsernameSubmitError, toCanonicalUsername } from "@/lib/validation/signup";

const COOLDOWN_DAYS = 30;

function nextChangeDate(usernameChangedAt: Date | null): Date | null {
  if (!usernameChangedAt) return null;
  const next = new Date(usernameChangedAt);
  next.setDate(next.getDate() + COOLDOWN_DAYS);
  return next > new Date() ? next : null;
}

function formatDate(date: Date) {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

export function UsernameCard({
  displayUsername,
  usernameChangedAt,
}: {
  displayUsername: string;
  usernameChangedAt: Date | null;
}) {
  const router = useRouter();
  const inputId = useId();

  const [value, setValue] = useState(displayUsername);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // Server-authoritative once a 429 comes back; seeded from the DB timestamp.
  const [lockedUntil, setLockedUntil] = useState<Date | null>(() => nextChangeDate(usernameChangedAt));

  const debounced = useDebouncedValue(value.trim(), 400);
  const [availability, setAvailability] = useState<{ username: string; available: boolean } | null>(null);

  const changed = toCanonicalUsername(value) !== toCanonicalUsername(displayUsername);
  const shapeError = changed ? getUsernameSubmitError(value) : undefined;

  useEffect(() => {
    const candidate = toCanonicalUsername(debounced);
    if (!candidate || candidate === toCanonicalUsername(displayUsername) || getUsernameSubmitError(debounced)) return;

    let ignore = false;
    (async () => {
      // A held handle answers 422, the same status the plugin uses for a reserved
      // word — both simply mean "taken" here.
      const { data, error: checkError } = await isUsernameAvailable({ username: candidate });
      if (ignore) return;
      setAvailability({ username: candidate, available: !checkError && data?.available === true });
    })();

    return () => {
      ignore = true;
    };
  }, [debounced, displayUsername]);

  const currentAvailability = availability?.username === toCanonicalUsername(value) ? availability : null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    const shape = getUsernameSubmitError(value);
    if (shape) {
      setError(shape);
      return;
    }

    setSaving(true);
    const res = await apiPatch<{ nextAllowedAt?: string }>("/api/me/username", { username: value.trim() });
    setSaving(false);

    if (!res.ok) {
      if (res.status === 429 && res.data.nextAllowedAt) setLockedUntil(new Date(res.data.nextAllowedAt));
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }

    toast.success("Username updated");
    // Starting now, the cooldown and the 30-day hold on the old handle both run.
    setLockedUntil(nextChangeDate(new Date()));
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Username</CardTitle>
        <CardDescription>You can change this once every {COOLDOWN_DAYS} days. Your old handle is held for {COOLDOWN_DAYS} days before anyone else can take it.</CardDescription>
      </CardHeader>
      <CardContent>
        {lockedUntil ? (
          <div className="flex flex-col gap-1.5">
            <Label>Username</Label>
            <Input value={`@${displayUsername}`} disabled className="h-9" />
            <p className="text-muted-foreground text-xs">You can change your username again on {formatDate(lockedUntil)}.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={inputId}>Username</Label>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">@</span>
                <Input
                  id={inputId}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  maxLength={30}
                  autoComplete="off"
                  aria-invalid={shapeError || currentAvailability?.available === false ? true : undefined}
                  className="h-9"
                />
              </div>
              {shapeError ? (
                <p className="text-destructive text-xs">{shapeError}</p>
              ) : changed && currentAvailability ? (
                <p className={`text-xs ${currentAvailability.available ? "text-success" : "text-destructive"}`}>
                  {currentAvailability.available ? "Available" : "That username is taken"}
                </p>
              ) : (
                <p className="text-muted-foreground text-xs">Lowercase letters, numbers, dots and underscores.</p>
              )}
            </div>

            {error && <p className="text-destructive text-sm">{error}</p>}

            <Button type="submit" size="lg" className="self-start" disabled={saving || !changed || Boolean(shapeError)}>
              {saving ? "Saving…" : "Change username"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
