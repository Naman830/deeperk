import Link from "next/link";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";

// Without this, an unmatched URL rendered Next's built-in 404, which ships its own
// document, follows the OS colour scheme and ignores the app's .dark class — a
// white page in a dark app. This one renders inside the root layout, so it picks
// up the theme and fonts for free.
export default function NotFound() {
  return (
    <main className="bg-background grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Compass size={28} className="text-muted-foreground opacity-60" />
        <div>
          <p className="text-sm font-medium">Page not found</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-sm">
            That link doesn&apos;t go anywhere. It may have moved or never existed.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/chats">Back to chats</Link>
        </Button>
      </div>
    </main>
  );
}
