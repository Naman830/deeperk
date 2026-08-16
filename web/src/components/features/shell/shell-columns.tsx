"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type ShellColumnsProps = {
  list: React.ReactNode;
  children: React.ReactNode;
  // Pathname prefixes that count as "detail" routes. On mobile only one column
  // fits, so a detail route replaces the list instead of sitting beside it.
  detailPrefixes?: string[];
};

export function ShellColumns({ list, children, detailPrefixes = [] }: ShellColumnsProps) {
  const pathname = usePathname();
  const isDetail = detailPrefixes.some((prefix) => pathname.startsWith(prefix));

  return (
    <>
      <div className={cn("h-full w-full shrink-0 md:block md:w-80 lg:w-88", isDetail && "hidden")}>{list}</div>
      <div className={cn("h-full min-w-0 flex-1 md:block", isDetail ? "block" : "hidden")}>{children}</div>
    </>
  );
}
