"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Palette, Shield, UserRound, Wrench } from "lucide-react";
import { ListColumn } from "@/components/app/list-column";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { href: "/settings", label: "Profile", description: "Name, photo, bio and links", icon: UserRound },
  { href: "/settings/privacy", label: "Privacy", description: "Who can find and see you", icon: Shield },
  { href: "/settings/account", label: "Account", description: "Username, email, password", icon: Wrench },
  { href: "/settings/appearance", label: "Appearance", description: "Theme", icon: Palette },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <ListColumn title="Settings">
      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map(({ href, label, description, icon: Icon }) => {
          // Exact match for /settings so it doesn't stay lit on every subsection.
          const active = href === "/settings" ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors",
                active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
              )}
            >
              <Icon size={17} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{label}</span>
                <span className={cn("block truncate text-xs", active ? "opacity-80" : "text-muted-foreground")}>{description}</span>
              </span>
            </Link>
          );
        })}
      </nav>
    </ListColumn>
  );
}
