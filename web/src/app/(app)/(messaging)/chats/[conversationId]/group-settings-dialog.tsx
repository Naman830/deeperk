import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings2, ShieldCheck, ShieldOff, UserMinus } from "lucide-react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { FormError } from "@/components/features/shell/form-error";
import { apiDelete, apiPatch, apiPost, GENERIC_ERROR } from "@/lib/api-client";
import { GROUP_NAME_MAX, GROUP_MAX_MEMBERS } from "@/lib/validation/chat";
import type { ConversationDetail } from "@/lib/chat/types";
import { useRealtime } from "../../../realtime-provider";
import { MemberPicker, type PickedUser } from "../../member-picker";

// No "use client": rendered from thread-header.tsx, inside chat-thread's boundary.

export function GroupSettingsDialog({ conversation, viewerId }: { conversation: ConversationDetail; viewerId: string }) {
  const router = useRouter();
  const { refreshConversations } = useRealtime();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(conversation.name ?? "");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PickedUser[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const canManage = conversation.role === "OWNER" || conversation.role === "ADMIN";
  const isOwner = conversation.role === "OWNER";

  async function run<T>(action: () => Promise<{ ok: boolean; data: T & { error?: string } }>) {
    setError(undefined);
    setBusy(true);
    const res = await action();
    setBusy(false);
    if (!res.ok) {
      // Inline: the dialog is still open, so this is the control to fix.
      setError(res.data.error ?? GENERIC_ERROR);
      return false;
    }
    await refreshConversations();
    router.refresh();
    return true;
  }

  async function rename() {
    await run(() => apiPatch(`/api/conversations/${conversation.id}`, { name }));
  }

  async function addMembers() {
    const ok = await run(() =>
      apiPost(`/api/conversations/${conversation.id}/members`, {
        usernames: picked.map((user) => user.username),
      }),
    );
    if (ok) {
      setPicked([]);
      setQuery("");
    }
  }

  async function removeMember(userId: string) {
    await run(() => apiDelete(`/api/conversations/${conversation.id}/members/${userId}`));
  }

  async function setRole(userId: string, role: "ADMIN" | "MEMBER") {
    await run(() => apiPatch(`/api/conversations/${conversation.id}/members/${userId}`, { role }));
  }

  async function leave() {
    setBusy(true);
    const res = await apiDelete(`/api/conversations/${conversation.id}/members/me`);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.data.error ?? GENERIC_ERROR);
      return;
    }
    setOpen(false);
    await refreshConversations();
    router.push("/chats");
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Group settings">
          <Settings2 />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Group settings</DialogTitle>
          <DialogDescription>
            {conversation.members.length} of {GROUP_MAX_MEMBERS} members
          </DialogDescription>
        </DialogHeader>

        <div className="scroll-thin flex max-h-[60vh] min-h-0 flex-col gap-4 overflow-y-auto">
          {canManage && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-rename">Name</Label>
              <div className="flex gap-2">
                <Input
                  id="group-rename"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={GROUP_NAME_MAX}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || name.trim() === (conversation.name ?? "")}
                  onClick={rename}
                >
                  Save
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label>Members</Label>
            <ul className="flex flex-col">
              {conversation.members.map((member) => {
                const isSelf = member.id === viewerId;
                // An ADMIN may act on MEMBERs only; the OWNER may act on anyone.
                const mayRemove = !isSelf && (isOwner || (canManage && member.role === "MEMBER"));
                return (
                  <li key={member.id} className="flex items-center gap-2.5 py-1.5">
                    <UserAvatar
                      src={member.avatarUrl}
                      firstName={member.firstName}
                      lastName={member.lastName}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {member.firstName} {member.lastName ?? ""} {isSelf && <span className="text-muted-foreground">(you)</span>}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        @{member.displayUsername} · {member.role.toLowerCase()}
                      </span>
                    </span>
                    {isOwner && !isSelf && member.role !== "OWNER" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={member.role === "ADMIN" ? `Demote @${member.displayUsername}` : `Make @${member.displayUsername} an admin`}
                        onClick={() => setRole(member.id, member.role === "ADMIN" ? "MEMBER" : "ADMIN")}
                      >
                        {member.role === "ADMIN" ? <ShieldOff /> : <ShieldCheck />}
                      </Button>
                    )}
                    {mayRemove && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`Remove @${member.displayUsername}`}
                        onClick={() => removeMember(member.id)}
                      >
                        <UserMinus />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {canManage && conversation.members.length < GROUP_MAX_MEMBERS && (
            <div className="flex flex-col gap-2">
              <Label>Add people</Label>
              <MemberPicker
                query={query}
                onQueryChange={setQuery}
                selected={picked}
                onToggle={(user) =>
                  setPicked((current) =>
                    current.some((item) => item.username === user.username)
                      ? current.filter((item) => item.username !== user.username)
                      : [...current, user],
                  )
                }
                excludeUsernames={conversation.members.map((member) => member.username)}
                disabled={busy}
              />
              <Button type="button" variant="outline" disabled={busy || picked.length === 0} onClick={addMembers}>
                Add {picked.length > 0 ? picked.length : ""}
              </Button>
            </div>
          )}

          <FormError>{error}</FormError>

          <Separator />

          <Button type="button" variant="destructive" disabled={busy} onClick={() => setLeaving(true)}>
            <LogOut /> Leave group
          </Button>
        </div>
      </DialogContent>

      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave this group?</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll stop receiving its messages. {isOwner && "Ownership passes to the longest-standing member."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={leave} disabled={busy}>
              Leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
