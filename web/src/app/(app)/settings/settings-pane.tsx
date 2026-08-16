import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { Button } from "@/components/ui/button";

// Shared frame for every Settings section: a header (with a mobile-only back
// link to the section list) over a scrolling body.
export function SettingsPane({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <MainPane>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-6">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
          <Link href="/settings" aria-label="Back to settings">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="font-heading truncate text-base font-semibold">{title}</h1>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:px-6">{children}</div>
      </div>
    </MainPane>
  );
}
