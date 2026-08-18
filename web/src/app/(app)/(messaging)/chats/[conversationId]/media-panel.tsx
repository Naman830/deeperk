import { useEffect, useState } from "react";
import { FileText, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatMessage } from "@/lib/chat/types";

// No "use client": rendered from thread-header.tsx.

/**
 * "Media, links & files" — every photo, video and file in this conversation.
 *
 * Loaded on open rather than with the thread: it is a panel most people never
 * open, and paying for it on every thread render would be a query per
 * navigation for nothing. Paginated on the same keyset cursor as history.
 */
export function MediaPanel({
  open,
  onOpenChange,
  conversationId,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  onJump: (messageId: string) => void;
}) {
  const [items, setItems] = useState<ChatMessage[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/media`);
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as {
          messages: ChatMessage[];
          nextCursor: string | null;
          hasMore: boolean;
        };
        if (cancelled) return;
        setItems(data.messages);
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, conversationId]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/conversations/${conversationId}/media?before=${encodeURIComponent(cursor)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as {
        messages: ChatMessage[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      setItems((current) => [...(current ?? []), ...data.messages]);
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Media, links & files</DialogTitle>
          <DialogDescription>Everything shared in this chat.</DialogDescription>
        </DialogHeader>

        <div className="scroll-thin max-h-[60vh] overflow-y-auto">
          {items === null ? (
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: 9 }).map((_, index) => (
                <Skeleton key={index} className="aspect-square rounded-md" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">Nothing shared yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onJump(item.id);
                    }}
                    title={item.mediaName ?? undefined}
                    className="bg-muted hover:ring-primary/60 relative aspect-square overflow-hidden rounded-md hover:ring-2"
                  >
                    {item.type === "IMAGE" && item.mediaUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- next/image
                         is used nowhere in this app by design; Cloudinary already
                         applies f_auto,q_auto and a size, and /_next/image would
                         re-proxy an already-optimised asset. */
                      <img
                        src={item.mediaUrl}
                        alt={item.mediaName ?? "Photo"}
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover"
                      />
                    ) : (
                      <span className="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 p-1">
                        {item.type === "VIDEO" ? <Video size={20} /> : <FileText size={20} />}
                        <span className="w-full truncate text-center text-[10px]">
                          {item.mediaName ?? item.type.toLowerCase()}
                        </span>
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {hasMore && (
                <div className="pt-3 text-center">
                  <Button type="button" variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
