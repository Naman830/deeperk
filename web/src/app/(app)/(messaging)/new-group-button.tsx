import { useState } from "react";
import { useRouter } from "next/navigation";
import { UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FormError } from "@/components/features/shell/form-error";
import { apiPost, GENERIC_ERROR } from "@/lib/api-client";
import { createGroupSchema, GROUP_MAX_MEMBERS, GROUP_NAME_MAX } from "@/lib/validation/chat";
import { useRealtime } from "../realtime-provider";
import { MemberPicker, type PickedUser } from "./member-picker";

// No "use client": ConversationColumn, its only importer, already opened the
// boundary. A bare "+" in a Chats header reads as "new chat", but DMs start
// from search here — so the icon and its tooltip say "group" explicitly.

export function NewGroupButton() {
  const router = useRouter();
  const { refreshConversations } = useRealtime();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PickedUser[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  function toggle(user: PickedUser) {
    setSelected((current) =>
      current.some((item) => item.username === user.username)
        ? current.filter((item) => item.username !== user.username)
        : [...current, user],
    );
  }

  function reset() {
    setName("");
    setQuery("");
    setSelected([]);
    setError(undefined);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);

    // Same schema the route re-validates with, so the inline message and the
    // server's answer can't disagree.
    const parsed = createGroupSchema.safeParse({
      name,
      memberUsernames: selected.map((user) => user.username),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the details and try again");
      return;
    }

    setSaving(true);
    const res = await apiPost<{ conversationId: string }>("/api/conversations/group", parsed.data);
    setSaving(false);

    if (!res.ok) {
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }
    setOpen(false);
    reset();
    await refreshConversations();
    router.push(`/chats/${res.data.conversationId}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="New group">
              <UsersRound />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>New group</TooltipContent>
      </Tooltip>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New group</DialogTitle>
            <DialogDescription>Pick a name and up to {GROUP_MAX_MEMBERS - 1} other people.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={GROUP_NAME_MAX}
              autoComplete="off"
            />
          </div>

          <MemberPicker query={query} onQueryChange={setQuery} selected={selected} onToggle={toggle} disabled={saving} />

          <FormError>{error}</FormError>

          <DialogFooter>
            <Button type="submit" disabled={saving || selected.length === 0}>
              {saving ? "Creating…" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
