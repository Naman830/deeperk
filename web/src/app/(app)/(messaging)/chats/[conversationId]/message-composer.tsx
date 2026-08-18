import { useId, useRef, useState } from "react";
import { Paperclip, SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormError } from "@/components/features/shell/form-error";
import { apiUpload, GENERIC_ERROR } from "@/lib/api-client";
import { MESSAGE_MAX_LENGTH, MEDIA_RULES, MEDIA_MAX_BYTES, type MediaKind } from "@/lib/validation/chat";
import { useTypingEmitter } from "@/lib/hooks/use-typing";
import { cn } from "@/lib/utils";
import { useRealtime } from "../../../realtime-provider";

// No "use client": chat-thread.tsx already opened the boundary. This file is
// full of hooks, and that's fine — a directive-free file calling useState fails
// loudly at build if it is ever imported from a server component, which is the
// failure mode this repo prefers over a needless second boundary.

const COUNTER_VISIBLE_FROM = MESSAGE_MAX_LENGTH - 400;

const ACCEPT = [...MEDIA_RULES.image.mimes, ...MEDIA_RULES.video.mimes, ...MEDIA_RULES.file.mimes].join(",");

export function MessageComposer({ conversationId }: { conversationId: string }) {
  const { connection, draftFor, setDraft, sendMessage, emitTyping } = useRealtime();
  const { bump, stop } = useTypingEmitter(conversationId, emitTyping);
  const counterId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);

  const draft = draftFor(conversationId);
  const overLimit = draft.length > MESSAGE_MAX_LENGTH;
  const nearLimit = draft.length >= COUNTER_VISIBLE_FROM;
  const canSend = draft.trim().length > 0 && !overLimit && !uploading;

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing: an Enter mid-IME means "commit the candidate", and sending
    // there cuts a half-typed Japanese or Korean word.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  }

  function send() {
    const text = draft.trim();
    if (text.length === 0) return;
    // Blocked pre-flight rather than left to the server. chat.md §8 says
    // "rejected, inline error", but by the time a server rejection arrives the
    // optimistic bubble exists — and then the failure has two channels.
    if (text.length > MESSAGE_MAX_LENGTH) {
      setError(`Messages can be up to ${MESSAGE_MAX_LENGTH} characters`);
      return;
    }
    setError(undefined);
    stop();
    sendMessage({
      clientMsgId: newClientMsgId(),
      conversationId,
      type: "TEXT",
      body: text,
      mediaUrl: null,
      mediaMime: null,
      mediaSize: null,
      mediaName: null,
    });
    setDraft(conversationId, "");
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file fires change again — the
    // same gotcha the avatar editor already documents.
    event.target.value = "";
    if (!file) return;

    setError(undefined);
    // Per-kind cap, not MEDIA_MAX_BYTES: the global max is the video cap, so a
    // 6MB image would pass here only to fail at the upload route. Unknown types
    // fall back to the global cap and let the server's sniff decide.
    const kind = (Object.keys(MEDIA_RULES) as MediaKind[]).find((key) =>
      (MEDIA_RULES[key].mimes as readonly string[]).includes(file.type),
    );
    const maxBytes = kind ? MEDIA_RULES[kind].maxBytes : MEDIA_MAX_BYTES;
    if (file.size > maxBytes) {
      setError(`That file is too large — the limit is ${Math.floor(maxBytes / (1024 * 1024))}MB`);
      return;
    }

    setUploading(true);
    const form = new FormData();
    form.append("conversationId", conversationId);
    form.append("file", file);
    const res = await apiUpload<{
      type: "IMAGE" | "VIDEO" | "FILE";
      mediaUrl: string;
      mediaMime: string;
      mediaSize: number;
      mediaName: string;
      mediaToken: string;
    }>("/api/upload/chat-media", form);
    setUploading(false);

    if (!res.ok) {
      // Pre-flight: no bubble exists yet, so this belongs inline.
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }

    sendMessage({
      clientMsgId: newClientMsgId(),
      conversationId,
      type: res.data.type,
      body: null,
      mediaUrl: res.data.mediaUrl,
      mediaMime: res.data.mediaMime,
      mediaSize: res.data.mediaSize,
      mediaName: res.data.mediaName,
      mediaToken: res.data.mediaToken,
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className="shrink-0 border-t p-2 md:p-3"
    >
      {connection === "offline" && (
        <p role="status" className="text-muted-foreground pb-2 text-center text-xs">
          Reconnecting…
        </p>
      )}

      <div className="flex items-end gap-2">
        <input ref={fileRef} type="file" accept={ACCEPT} onChange={handleFile} className="hidden" />
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          aria-label="Attach a file"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="size-10 shrink-0 md:size-9"
        >
          <Paperclip />
        </Button>

        <Textarea
          value={draft}
          onChange={(event) => {
            setDraft(conversationId, event.target.value);
            bump();
          }}
          onBlur={stop}
          onKeyDown={handleKeyDown}
          rows={1}
          enterKeyHint="send"
          placeholder="Write a message"
          aria-label="Write a message"
          aria-invalid={overLimit || undefined}
          aria-describedby={overLimit ? counterId : undefined}
          // The primitive is field-sizing-content min-h-16 with no cap: 64px is
          // too tall for one line, and uncapped growth pushes the thread off
          // screen on a long message.
          className="max-h-32 min-h-9 resize-none py-1.5"
        />

        {/* size-10 below md: icon-lg is 36px, under the 44px touch target. */}
        <Button type="submit" size="icon-lg" aria-label="Send" disabled={!canSend} className="size-10 shrink-0 md:size-9">
          <SendHorizontal />
        </Button>
      </div>

      {nearLimit && (
        <p
          id={counterId}
          aria-live={overLimit ? "polite" : "off"}
          className={cn("mt-1 text-right text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}
        >
          {draft.length}/{MESSAGE_MAX_LENGTH}
        </p>
      )}

      <FormError className="mt-1">{uploading ? undefined : error}</FormError>
      {uploading && <p className="text-muted-foreground mt-1 text-xs">Uploading…</p>}
    </form>
  );
}

function newClientMsgId(): string {
  // crypto.randomUUID needs a secure context — localhost qualifies, a LAN IP
  // over plain http does not.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `t_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}
