import { Skeleton } from "@/components/ui/skeleton";

// Covers every /settings section, each of which awaits getSession() AND
// getOwnProfile(). Sits at the settings segment rather than at (app)/ because a
// loading.tsx cannot cover its own layout's data access: (app)/layout.tsx reads
// headers() via getSession(), which blocks navigation outright, so an (app)/
// fallback would never render. Here the nav list stays on screen while the pane
// swaps.
//
// Safe here specifically because no /settings page calls notFound(). Adding a
// loading.tsx to a segment that does — /u/[username] — silently downgrades its
// 404 to a 200: the Suspense boundary starts streaming, headers flush, and the
// status can no longer be changed. See CLAUDE.md.
export default function SettingsLoading() {
  return (
    <div className="bg-background h-full w-full min-w-0">
      <div className="flex h-14 items-center gap-2 border-b px-3 md:px-6">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-6 md:px-6">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}
