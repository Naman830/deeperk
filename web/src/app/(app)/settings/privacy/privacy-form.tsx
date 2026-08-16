"use client";

import { useState } from "react";
import { toast } from "react-toastify";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { apiPatch, GENERIC_ERROR } from "@/lib/api-client";
import type { OwnPrivacy, PrivacyAudience } from "@/lib/profile/own-profile";

// Docs/user/profile.md §3 — EVERYONE/NOBODY only; there is no relationship graph
// yet, so no FRIENDS tier to pick from. A two-state switch is the honest control.
const ROWS: { key: keyof OwnPrivacy; label: string; description: string }[] = [
  {
    key: "discoverable",
    label: "Let people find me in search",
    description: "When off, you won't appear in username search results.",
  },
  {
    key: "onlineStatus",
    label: "Show when I'm online",
    description: "Controls your online dot and last-seen time on your profile.",
  },
  {
    key: "profileDetails",
    label: "Show my bio and links",
    description: "Your name, username and photo always stay visible.",
  },
];

export function PrivacyForm({ initial }: { initial: OwnPrivacy }) {
  const [privacy, setPrivacy] = useState(initial);
  const [pending, setPending] = useState<keyof OwnPrivacy | null>(null);

  async function toggle(key: keyof OwnPrivacy, enabled: boolean) {
    const next: PrivacyAudience = enabled ? "EVERYONE" : "NOBODY";
    const previous = privacy[key];

    // Optimistic — a toggle that lags behind the tap feels broken.
    setPrivacy((current) => ({ ...current, [key]: next }));
    setPending(key);
    const res = await apiPatch("/api/me/privacy", { [key]: next });
    setPending(null);

    if (!res.ok) {
      setPrivacy((current) => ({ ...current, [key]: previous }));
      toast.error(res.data.error ?? GENERIC_ERROR);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col divide-y">
        {ROWS.map(({ key, label, description }) => (
          <div key={key} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <Label htmlFor={`privacy-${key}`}>{label}</Label>
              <p className="text-muted-foreground mt-1 text-xs">{description}</p>
            </div>
            <Switch
              id={`privacy-${key}`}
              checked={privacy[key] === "EVERYONE"}
              disabled={pending === key}
              onCheckedChange={(checked) => toggle(key, checked)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
