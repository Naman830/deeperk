"use client";

// Last-resort boundary: it replaces the ROOT layout, so it must ship its own
// <html>/<body> and import the stylesheet itself — none of the app's chrome,
// providers or fonts reach it.
//
// `className="dark"` is hard-coded rather than reading the stored preference:
// THEME_INIT_SCRIPT lives in the root layout that just failed, and re-running
// theme detection inside a crash path is exactly where not to add moving parts.
// Dark is the app's documented default when nothing is stored.
import "./globals.css";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground antialiased">
        <main className="grid min-h-dvh place-items-center px-6">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <p className="text-sm font-medium">Deeperk hit an unexpected error</p>
            <p className="text-muted-foreground text-sm">
              The app couldn&apos;t recover on its own. Reloading usually fixes it.
            </p>
            <button
              onClick={() => unstable_retry()}
              className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium"
            >
              Try again
            </button>
            {error.digest && <span className="text-muted-foreground text-xs">Reference: {error.digest}</span>}
          </div>
        </main>
      </body>
    </html>
  );
}
