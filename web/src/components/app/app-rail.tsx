"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageCircle, Phone, Settings, LogOut, UserRound } from "lucide-react";
import { signOut } from "@/lib/auth/client";
import { UserAvatar } from "@/components/app/user-avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NAV = [
  // /u/* is reached from the chats column's search, so it keeps Chats lit.
  { href: "/chats", label: "Chats", icon: MessageCircle, match: ["/chats", "/u/"] },
  { href: "/calls", label: "Calls", icon: Phone, match: ["/calls"] },
  { href: "/settings", label: "Settings", icon: Settings, match: ["/settings"] },
];

type AppRailProps = {
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
};

export function AppRail({ username, displayUsername, firstName, lastName, avatarUrl }: AppRailProps) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav
      aria-label="Main"
      className="bg-sidebar fixed inset-x-0 bottom-0 z-20 flex h-16 shrink-0 items-center justify-around border-t md:static md:h-full md:w-60 md:flex-col md:items-stretch md:justify-start md:border-t-0 md:border-r md:px-3 md:py-4 lg:w-64"
    >
      <span className="font-heading hidden px-3 pb-6 text-lg font-semibold tracking-tight md:block">ChatSphere</span>

      <div className="contents md:flex md:flex-col md:gap-1">
        {NAV.map(({ href, label, icon: Icon, match }) => {
          const active = match.some((prefix) => pathname.startsWith(prefix));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors md:flex-row md:gap-3 md:text-sm",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              )}
            >
              <Icon size={20} />
              {label}
            </Link>
          );
        })}
      </div>

      <div className="md:mt-auto md:pt-4">
        <DropdownMenu>
          {/* On mobile this is the 4th tab, so it takes the same stacked
              icon-over-label shape as the other three. */}
          <DropdownMenuTrigger className="hover:bg-sidebar-accent/50 text-muted-foreground flex w-full flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors md:flex-row md:gap-2.5 md:border md:px-2 md:text-left">
            <UserAvatar src={avatarUrl} firstName={firstName} lastName={lastName} size="sm" className="size-5 md:size-8" />
            <span className="md:hidden">You</span>
            <span className="hidden min-w-0 flex-1 md:block">
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
