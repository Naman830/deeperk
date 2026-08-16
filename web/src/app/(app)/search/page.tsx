import type { Metadata } from "next";
import { SearchPanel } from "./search-panel";

export const metadata: Metadata = { title: "Search" };

// Standalone /search, per Docs/user/search.md §2. The same control also lives at
// the top of the conversation column; this route exists so search is
// deep-linkable and reachable as a full screen on mobile.
export default function SearchPage() {
  return <SearchPanel />;
}
