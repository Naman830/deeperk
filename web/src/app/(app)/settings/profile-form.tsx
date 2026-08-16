"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiPatch, GENERIC_ERROR } from "@/lib/api-client";
import { updateProfileSchema } from "@/lib/validation/profile";
import type { OwnProfile } from "@/lib/profile/own-profile";

const MAX_BIO = 250;
const MAX_LINKS = 4;

type LinkRow = { platform: string; url: string };

export function ProfileForm({ profile }: { profile: OwnProfile }) {
  const router = useRouter();
  const firstNameId = useId();
  const lastNameId = useId();
  const bioId = useId();

  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [links, setLinks] = useState<LinkRow[]>(profile.socialLinks.map(({ platform, url }) => ({ platform, url })));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  function updateLink(index: number, patch: Partial<LinkRow>) {
    setLinks((current) => current.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    // Blank rows are treated as "not filled in" rather than as errors, so a user
    // can add a row, change their mind, and still save.
    const socialLinks = links.filter((link) => link.platform.trim() !== "" || link.url.trim() !== "");

    const parsed = updateProfileSchema.safeParse({ firstName, lastName, bio, socialLinks });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_ERROR);
      return;
    }

    setSaving(true);
    // socialLinks is a full replace server-side, so the whole array always goes.
    const res = await apiPatch("/api/me", parsed.data);
    setSaving(false);

    if (!res.ok) {
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }
    toast.success("Profile saved");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <Card>
        <CardHeader>
          <CardTitle>Your details</CardTitle>
          <CardDescription>This is what people see on your public profile.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={firstNameId}>First name</Label>
              <Input id={firstNameId} value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={25} className="h-9" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={lastNameId}>Last name</Label>
              <Input id={lastNameId} value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={25} className="h-9" />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <Label htmlFor={bioId}>Bio</Label>
              <span className={`text-xs ${bio.length > MAX_BIO ? "text-destructive" : "text-muted-foreground"}`}>
                {bio.length}/{MAX_BIO}
              </span>
            </div>
            <Textarea
              id={bioId}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="Tell people a little about yourself"
            />
            <p className="text-muted-foreground text-xs">Plain text only — links aren&apos;t allowed.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Social links</CardTitle>
          <CardDescription>Up to {MAX_LINKS} links, shown on your public profile.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {links.length === 0 && <p className="text-muted-foreground text-sm">No links yet.</p>}

          {links.map((link, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={link.platform}
                onChange={(e) => updateLink(index, { platform: e.target.value })}
                placeholder="Platform"
                aria-label={`Link ${index + 1} platform`}
                maxLength={50}
                className="h-9 w-32 shrink-0"
              />
              <Input
                value={link.url}
                onChange={(e) => updateLink(index, { url: e.target.value })}
                placeholder="https://…"
                aria-label={`Link ${index + 1} URL`}
                inputMode="url"
                className="h-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove link ${index + 1}`}
                onClick={() => setLinks((current) => current.filter((_, i) => i !== index))}
              >
                <X />
              </Button>
            </div>
          ))}

          {links.length < MAX_LINKS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setLinks((current) => [...current, { platform: "", url: "" }])}
            >
              <Plus /> Add link
            </Button>
          )}
        </CardContent>
      </Card>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
