"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Cropper, { type Area } from "react-easy-crop";
import { toast } from "react-toastify";
import { Trash2, Upload } from "lucide-react";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiDelete, apiUpload, GENERIC_ERROR } from "@/lib/api-client";
import { AVATAR_RULES } from "@/lib/validation/profile";

// Docs/user/profile.md §4 — the server re-checks all of this from the real
// bytes; these client checks only save a doomed round trip.
const ACCEPT = "image/jpeg,image/png,image/webp";
const OUTPUT_SIZE = 512;

type AvatarEditorProps = {
  avatarUrl: string | null;
  firstName: string;
  lastName: string | null;
};

// Draw the selected crop box onto a square canvas at OUTPUT_SIZE. Canvas export
// also drops EXIF, so nothing location-bearing leaves the browser.
async function cropToBlob(imageSrc: string, crop: Area): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.addEventListener("load", () => resolve(element));
    element.addEventListener("error", () => reject(new Error("Could not read that image")));
    element.src = imageSrc;
  });

  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT_SIZE;
  canvas.height = OUTPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not read that image");

  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not read that image"))), "image/jpeg", 0.92);
  });
}

export function AvatarEditor({ avatarUrl, firstName, lastName }: AvatarEditorProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  // Keeps the buttons disabled until the refreshed server data actually lands.
  const [refreshing, startRefresh] = useTransition();

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => setCroppedArea(areaPixels), []);

  function closeCropper() {
    if (source) URL.revokeObjectURL(source);
    setSource(null);
    setCroppedArea(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file fires change again.
    event.target.value = "";
    if (!file) return;

    if (file.size > AVATAR_RULES.maxBytes) {
      toast.error("Image must be 5MB or smaller");
      return;
    }
    setSource(URL.createObjectURL(file));
  }

  async function handleUpload() {
    if (!source || !croppedArea) return;
    setBusy(true);
    try {
      const blob = await cropToBlob(source, croppedArea);
      const form = new FormData();
      form.append("avatar", blob, "avatar.jpg");

      const res = await apiUpload("/api/me/avatar", form);
      if (!res.ok) {
        // The route's own copy is already user-facing and specific (415, 413,
        // 429, and the 503 "not configured" until Cloudinary keys are set).
        toast.error(res.data.error ?? GENERIC_ERROR);
        return;
      }
      closeCropper();
      toast.success("Photo updated");
      startRefresh(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    const res = await apiDelete("/api/me/avatar");
    setBusy(false);
    if (!res.ok) {
      toast.error(res.data.error ?? GENERIC_ERROR);
      return;
    }
    toast.success("Photo removed");
    startRefresh(() => router.refresh());
  }

  return (
    <div className="flex items-center gap-4">
      <UserAvatar src={avatarUrl} firstName={firstName} lastName={lastName} size="lg" />

      <div className="flex flex-wrap gap-2">
        <input ref={fileInputRef} type="file" accept={ACCEPT} onChange={handleFile} className="hidden" />
        <Button variant="outline" size="lg" disabled={busy || refreshing} onClick={() => fileInputRef.current?.click()}>
          <Upload /> {avatarUrl ? "Change photo" : "Upload photo"}
        </Button>
        {avatarUrl && (
          <Button variant="destructive" size="lg" disabled={busy || refreshing} onClick={handleRemove}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>

      <Dialog open={source !== null} onOpenChange={(next) => !next && closeCropper()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Crop your photo</DialogTitle>
            <DialogDescription>Drag to reposition, and use the slider to zoom.</DialogDescription>
          </DialogHeader>

          <div className="bg-muted relative h-64 w-full overflow-hidden rounded-lg">
            {source && (
              <Cropper
                image={source}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape="round"
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={onCropComplete}
              />
            )}
          </div>

          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            aria-label="Zoom"
            onChange={(event) => setZoom(Number(event.target.value))}
            className="accent-primary w-full"
          />

          <DialogFooter>
            <Button variant="outline" onClick={closeCropper} disabled={busy || refreshing}>
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={busy || refreshing || !croppedArea}>
              {busy ? "Uploading…" : "Save photo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
