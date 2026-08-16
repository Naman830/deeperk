"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageCircle, Phone, Settings, LogOut, UserRound, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { persistRailState } from "./rail-cookie";

const NAV = [
  // /u/* is reached from the chats column's search, and /search is the same
  // feature on its own route, so both keep Chats lit.
  { href: "/chats", label: "Chats", icon: MessageCircle, match: ["/chats", "/u/", "/search"] },
  { href: "/calls", label: "Calls", icon: Phone, match: ["/calls"] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/settings"] },
];

type AppRailProps = {
  defaultCollapsed: boolean;
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
};

export function AppRail({ defaultCollapsed, username, displayUsername, firstName, lastName, avatarUrl }: AppRailProps) {
  const pathname = usePathname();
  const router = useRouter();
  const navId = useId();
  // Seeded from the server-rendered value, so the first client render matches the
  // markup exactly — no hydration mismatch and no width flash.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  function toggle() {
    setCollapsed((current) => {
      const next = !current;
      persistRailState(next);
      return next;
    });
  }

  // Cmd/Ctrl+B. Radix skips its menu typeahead whenever a modifier is held, so
  // there's no conflict there; preventDefault is for Firefox's bookmarks sidebar.
  // Bound unconditionally — below md every class this touches is md:-prefixed, so
  // toggling is a visual no-op on mobile rather than something to branch on.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "b" || !(event.metaKey || event.ctrlKey) || event.repeat) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function handleSignOut() {
    await signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav
      id={navId}
      aria-label="Main"
      className={cn(
        "bg-sidebar fixed inset-x-0 bottom-0 z-20 flex h-16 shrink-0 items-center justify-around border-t md:static md:h-full md:flex-col md:items-stretch md:justify-start md:border-t-0 md:border-r md:px-3 md:py-4",
        // Width is the only animated property: the shell is a flex row with
        // min-w-0 flex-1 beside it, so siblings reflow for free. Animating
        // transform instead would overlap content.
        "overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "md:w-16" : "md:w-60 lg:w-64",
      )}
    >
      <div className="hidden md:mb-4 md:flex md:items-center md:justify-between md:gap-2">
        {!collapsed && <span className="font-heading truncate px-1 text-lg font-semibold tracking-tight">ChatSphere</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-controls={navId}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={cn("shrink-0", collapsed && "mx-auto")}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? "Expand sidebar" : "Collapse sidebar"} · ⌘B</TooltipContent>
        </Tooltip>
      </div>

      <div className="contents md:flex md:flex-col md:gap-1">
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((prefix) => pathname.startsWith(prefix));
          const link = (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors md:flex-row md:gap-3 md:text-sm",
                collapsed && "md:justify-center md:px-0",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              )}
            >
              <Icon size={20} className="shrink-0" />
              <span className={cn("whitespace-nowrap", collapsed && "md:hidden")}>{label}</span>
            </Link>
          );

          // Only worth a tooltip when the label is hidden. TooltipProvider is
          // mounted once in app/layout.tsx at delayDuration 0; override per-tooltip
          // so the rail doesn't fire instantly on every pass of the cursor.
          return collapsed ? (
            <Tooltip key={href} delayDuration={400}>
              <TooltipTrigger asChild>{link}</TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ) : (
            link
          );
        })}
      </div>

      <div className="md:mt-auto md:pt-4">
        <DropdownMenu>
          {/* On mobile this is the 4th tab, so it takes the same stacked
              icon-over-label shape as the other three. */}
          <DropdownMenuTrigger
            aria-label={collapsed ? `${firstName} ${lastName ?? ""}`.trim() : undefined}
            className={cn(
              "hover:bg-sidebar-accent/50 text-muted-foreground flex w-full flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors md:flex-row md:gap-2.5 md:text-left",
              collapsed ? "md:justify-center md:px-0" : "md:border md:px-2",
            )}
          >
            <UserAvatar src={avatarUrl} firstName={firstName} lastName={lastName} size="sm" className="size-5 md:size-8" />
            <span className="md:hidden">You</span>
            <span className={cn("hidden min-w-0 flex-1 md:block", collapsed && "md:hidden")}>
              <span className="text-sidebar-foreground block truncate text-sm font-medium">
                {firstName} {lastName ?? ""}
              </span>
              <span className="text-muted-foreground block truncate text-xs">@{displayUsername}</span>
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuItem asChild>
              <Link href={`/u/${username}`}>
                <UserRound /> View profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/settings">
                <Settings /> Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={handleSignOut}>
              <LogOut /> Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
