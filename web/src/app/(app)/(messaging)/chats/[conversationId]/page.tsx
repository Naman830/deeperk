import { cache } from "react";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getConversationThread } from "@/lib/chat/messages";
import { ChatThread } from "./chat-thread";

// cache() so generateMetadata and the page share one round trip rather than
// running the same query twice per navigation.
const loadThread = cache(getConversationThread);

// NOTE: this segment must never gain a loading.tsx. It calls notFound(), and a
// Suspense boundary starts streaming — headers flush, and the 404 silently
// becomes a 200. Already observed and documented in this repo for
// /u/[username].

export async function generateMetadata({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}): Promise<Metadata> {
  const session = await getSession();
  if (!session) return { title: "Chats" };
  const { conversationId } = await params;
  const thread = await loadThread(conversationId, session.user.id);
  if (!thread) return { title: "Chats" };
  return { title: conversationTitle(thread.conversation, session.user.id) };
}

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { conversationId } = await params;
  // Returns null for "doesn't exist" and "you're not a member" alike, so both
  // render one identical 404 and membership can't be probed by status code.
  const thread = await loadThread(conversationId, session.user.id);
  if (!thread) notFound();

  return (
    <ChatThread
      viewerId={session.user.id}
      conversation={thread.conversation}
      initialMessages={thread.messages}
      initialCursor={thread.nextCursor}
      initialHasMore={thread.hasMore}
    />
  );
}

function conversationTitle(
  conversation: { type: string; name: string | null; members: { id: string; firstName: string; lastName: string | null }[] },
  viewerId: string,
): string {
  if (conversation.type === "GROUP") return conversation.name ?? "Group";
  const other = conversation.members.find((member) => member.id !== viewerId);
  if (!other) return "Chat";
  return `${other.firstName} ${other.lastName ?? ""}`.trim();
}
