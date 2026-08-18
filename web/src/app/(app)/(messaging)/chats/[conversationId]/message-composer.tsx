import { useId, useMemo, useRef, useState } from "react";
import { Paperclip, Pencil, Reply, SendHorizontal, Smile, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { FormError } from "@/components/features/shell/form-error";
import { apiUpload, GENERIC_ERROR } from "@/lib/api-client";
import { MESSAGE_MAX_LENGTH, MEDIA_RULES, MEDIA_MAX_BYTES, type MediaKind } from "@/lib/validation/chat";
import { EMOJI_GROUPS } from "@/lib/chat/emoji";
import { useTypingEmitter } from "@/lib/hooks/use-typing";
import { cn } from "@/lib/utils";
import type { ChatMember } from "@/lib/chat/types";
import { useRealtime } from "../../../realtime-provider";

// No "use client": chat-thread.tsx already opened the boundary. This file is
// full of hooks, and that's fine — a directive-free file calling useState fails
// loudly at build if it is ever imported from a server component, which is the
// failure mode this repo prefers over a needless second boundary.

const COUNTER_VISIBLE_FROM = MESSAGE_MAX_LENGTH - 400;

const ACCEPT = [...MEDIA_RULES.image.mimes, ...MEDIA_RULES.video.mimes, ...MEDIA_RULES.file.mimes].join(",");

/** The @token immediately before the caret, if the caret is inside one. */
function mentionQueryAt(value: string, caret: number): { query: string; start: number } | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  // Must start a word: "a@b" is an email, not a mention.
  if (at > 0 && !/\s/.test(upToCaret[at - 1])) return null;
  const query = upToCaret.slice(at + 1);
  // A space closes the token — mentions never contain one.
  if (/\s/.test(query) || query.length > 30) return null;
  return { query, start: at };
}

export function MessageComposer({
  conversationId,
  members,
  isGroup,
}: {
  conversationId: string;
  members: ChatMember[];
  isGroup: boolean;
}) {
  const {
    connection,
    viewerId,
    draftFor,
    setDraft,
    sendMessage,
    emitTyping,
    replyFor,
    setReply,
    editFor,
    setEdit,
    editMessage,
  } = useRealtime();
  const { bump, stop } = useTypingEmitter(conversationId, emitTyping);
  const counterId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caret, setCaret] = useState(0);

  const reply = replyFor(conversationId);
  const editing = editFor(conversationId);

  // While editing, the composer holds the edited body rather than the draft —
  // so cancelling an edit restores whatever was half-typed before it started.
  const draft = draftFor(conversationId);
  const [editDraft, setEditDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  // Seeding during render rather than in an effect: an effect would render the
  // empty field once and then fill it, which React 19's set-state-in-effect
  // rule forbids and which flashes a blank composer.
  if (editing && editing.messageId !== editingId) {
    setEditingId(editing.messageId);
    setEditDraft(editing.body);
  }
  if (!editing && editingId !== null) setEditingId(null);

  const value = editing ? editDraft : draft;

  const overLimit = value.length > MESSAGE_MAX_LENGTH;
  const nearLimit = value.length >= COUNTER_VISIBLE_FROM;
  const canSend = value.trim().length > 0 && !overLimit && !uploading && !saving;

  // Mentions are a group affordance. In a DM the only person you could mention
  // is the one you are already talking to.
  const mention = isGroup ? mentionQueryAt(value, caret) : null;
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return members
      .filter((member) => member.id !== viewerId)
      .filter(
        (member) =>
          member.username.toLowerCase().startsWith(query) ||
          `${member.firstName} ${member.lastName ?? ""}`.toLowerCase().includes(query),
      )
      .slice(0, 6);
  }, [mention, members, viewerId]);

  function write(next: string) {
    if (editing) setEditDraft(next);
    else setDraft(conversationId, next);
  }

  function cancelEdit() {
    setEdit(conversationId, null);
    setEditDraft("");
  }

  function insertMention(member: ChatMember) {
    if (!mention) return;
    const next = `${value.slice(0, mention.start)}@${member.username} ${value.slice(caret)}`;
    write(next);
    const position = mention.start + member.username.length + 2;
    // Restored after React has written the new value, or the browser puts the
    // caret back at the end of the field.
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      if (editing) {
        cancelEdit();
        event.preventDefault();
        // Stops chat-thread's Esc handler from also closing the whole thread.
        event.stopPropagation();
        return;
      }
      if (reply) {
        setReply(conversationId, null);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
    if (mentionMatches.length > 0 && (event.key === "Tab" || event.key === "Enter") && !event.shiftKey) {
      event.preventDefault();
      insertMention(mentionMatches[0]);
      return;
    }
    // isComposing: an Enter mid-IME means "commit the candidate", and sending
    // there cuts a half-typed Japanese or Korean word.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  }

  async function submit() {
    const text = value.trim();
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

    if (editing) {
      setSaving(true);
      const failure = await editMessage(editing.messageId, text);
      setSaving(false);
      if (failure) {
        setError(failure);
        return;
      }
      cancelEdit();
      return;
    }

    sendMessage({
      clientMsgId: newClientMsgId(),
      conversationId,
      type: "TEXT",
      body: text,
      mediaUrl: null,
      mediaMime: null,
      mediaSize: null,
      mediaName: null,
      replyToId: reply?.messageId ?? null,
    });
    setDraft(conversationId, "");
    setReply(conversationId, null);
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
      replyToId: reply?.messageId ?? null,
    });
    setReply(conversationId, null);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="bg-background/80 shrink-0 border-t p-2 backdrop-blur md:p-3"
    >
      {connection === "offline" && (
        <p role="status" className="text-muted-foreground pb-2 text-center text-xs">
          Reconnecting…
        </p>
      )}

      {/* Reply and edit are mutually exclusive by construction — setReply clears
          any edit and vice versa in the provider — so only one strip can show. */}
      {(reply || editing) && (
        <div className="bg-muted/60 border-l-primary mb-2 flex items-center gap-2 rounded-lg border-l-2 px-2 py-1.5">
          {editing ? (
            <Pencil size={14} className="text-primary shrink-0" />
          ) : (
            <Reply size={14} className="text-primary shrink-0" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {editing ? "Editing message" : `Replying to ${reply!.senderName}`}
            </span>
            <span className="text-muted-foreground block truncate text-xs">
              {editing ? editing.body : reply!.preview}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={editing ? "Cancel edit" : "Cancel reply"}
            onClick={() => (editing ? cancelEdit() : setReply(conversationId, null))}
          >
            <X />
          </Button>
        </div>
      )}

      {/* Mention autocomplete. Rendered above the field rather than in a
          Popover: a Popover moves focus out of the textarea, and the caret has
          to stay put for the insertion to be correct. */}
      {mentionMatches.length > 0 && (
        <ul className="bg-popover mb-2 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-md">
          {mentionMatches.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                // onMouseDown, not onClick: onClick fires after the textarea has
                // already blurred, which loses the caret position the insertion
                // depends on.
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(member);
                }}
                className={cn(
                  "hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  index === 0 && "bg-accent/50",
                )}
              >
                <UserAvatar src={member.avatarUrl} firstName={member.firstName} lastName={member.lastName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {`${member.firstName} ${member.lastName ?? ""}`.trim()}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">@{member.displayUsername}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-1.5">
        <input ref={fileRef} type="file" accept={ACCEPT} onChange={handleFile} className="hidden" />
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          aria-label="Attach a file"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="size-10 shrink-0 rounded-full md:size-9"
        >
          <Paperclip />
        </Button>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon-lg"
              variant="ghost"
              aria-label="Insert emoji"
              className="hidden size-9 shrink-0 rounded-full @md/pane:inline-flex"
            >
              <Smile />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <div className="scroll-thin max-h-64 overflow-y-auto">
              {EMOJI_GROUPS.map((group) => (
                <div key={group.label} className="mb-2 last:mb-0">
                  <p className="text-muted-foreground px-1 pb-1 text-[11px] font-medium">{group.label}</p>
                  <div className="grid grid-cols-8 gap-0.5">
                    {group.emoji.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        aria-label={emoji}
                        onClick={() => write(value + emoji)}
                        className="hover:bg-accent grid size-8 place-items-center rounded-md text-lg"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => {
            write(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            bump();
          }}
          onSelect={(event) => setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onBlur={stop}
          onKeyDown={handleKeyDown}
          rows={1}
          enterKeyHint="send"
          placeholder={editing ? "Edit your message" : "Write a message"}
          aria-label="Write a message"
          aria-invalid={overLimit || undefined}
          aria-describedby={overLimit ? counterId : undefined}
          // The primitive is field-sizing-content min-h-16 with no cap: 64px is
          // too tall for one line, and uncapped growth pushes the thread off
          // screen on a long message.
          className="max-h-32 min-h-9 resize-none rounded-2xl py-1.5"
        />

        {/* size-10 below md: icon-lg is 36px, under the 44px touch target. */}
        <Button
          type="submit"
          size="icon-lg"
          aria-label={editing ? "Save edit" : "Send"}
          disabled={!canSend}
          className="size-10 shrink-0 rounded-full transition-transform active:scale-95 md:size-9"
        >
          <SendHorizontal />
        </Button>
      </div>

      {nearLimit && (
        <p
          id={counterId}
          aria-live={overLimit ? "polite" : "off"}
          className={cn("mt-1 text-right text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}
        >
          {value.length}/{MESSAGE_MAX_LENGTH}
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
