import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/features/shell/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Deeperk",
    template: "%s · Deeperk",
  },
  description: "Real-time chat and voice/video calling.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: the inline script below stamps data-theme on
    // <html> before React hydrates, so server and client markup differ by design.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground min-h-dvh antialiased">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
        {/* theme="light" so the --toastify-*-light vars apply; globals.css remaps
            them to the design tokens and re-keys them on .dark. "colored" ignored
            the palette, so toasts never matched the theme picker. */}
        {/* limit={3}: without a cap, ten active group chats stack ten toasts
            over the whole screen — the owner's "awkward" complaint. Each
            conversation already collapses onto one toastId, so three is three
            distinct conversations, not three messages.
            pauseOnFocusLoss={false}: the default freezes the timer whenever the
            window blurs, so a toast raised while you were in another app is
            still sitting there when you come back. */}
        <ToastContainer position="top-center" theme="light" limit={3} pauseOnFocusLoss={false} />
      </body>
    </html>
  );
}
