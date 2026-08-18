import type { ChatMember } from "./types";

/**
 * Turns a message body into JSX: links, @mentions, everything else as text.
 *
 * PLAIN JSX ONLY. Never dangerouslySetInnerHTML — message-bubble.tsx already
 * documents that its plain-JSX rendering "is the entire XSS defence", and an
 * autolinker is precisely the place where that gets thrown away by accident.
 * Every branch below returns a React element built from a *string*, so the body
 * is escaped by React no matter what it contains.
 */

/**
 * Conservative on purpose.
 *
 * Requires a scheme or a leading `www.`, so "e.g. or something" and a sentence
 * ending in a full stop don't become links, and `[^\s<>"']` stops a trailing
 * quote or bracket being swallowed. Bare domains ("example.com") are
 * deliberately NOT matched: the false-positive rate on ordinary prose is far
 * worse than the cost of typing "https://".
 */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** A mention is @ + a username, using the same shape rule as signup. */
const MENTION_PATTERN = /@([a-z0-9_]{3,30})/gi;

const TOKEN_PATTERN = new RegExp(`(${URL_PATTERN.source})|(${MENTION_PATTERN.source})`, "gi");

/** Trailing punctuation almost always belongs to the sentence, not the URL. */
function trimTrailingPunctuation(url: string): { url: string; tail: string } {
  const match = /[.,;:!?)\]}]+$/.exec(url);
  if (!match) return { url, tail: "" };
  return { url: url.slice(0, match.index), tail: match[0] };
}

export function renderMessageBody(
  body: string,
  options: { members?: Map<string, ChatMember>; viewerUsername?: string } = {},
): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  // A fresh RegExp per call: a module-level /g regex carries lastIndex between
  // calls, so sharing one would make every second message render wrong.
  const pattern = new RegExp(TOKEN_PATTERN.source, "gi");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    if (match.index > cursor) nodes.push(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    if (match[1]) {
      const { url, tail } = trimTrailingPunctuation(match[1]);
      const href = url.startsWith("www.") ? `https://${url}` : url;
      nodes.push(
        <a
          key={`l${key++}`}
          href={href}
          target="_blank"
          // noopener AND noreferrer, matching the existing media anchors: without
          // noopener the opened page gets a handle on this window.
          rel="noopener noreferrer"
          className="underline decoration-current/40 underline-offset-2 hover:decoration-current"
        >
          {url}
        </a>,
      );
      if (tail) nodes.push(tail);
      continue;
    }

    // match[2] is the whole "@handle", match[3] the handle itself.
    const handle = match[3]?.toLowerCase();
    const member = handle ? findMember(options.members, handle) : undefined;
    if (!member) {
      // Not a member of this conversation, so it is just text that happens to
      // start with @. Rendering it as a mention would imply a person who isn't
      // here — and, in a group, leak that a handle exists.
      nodes.push(match[0]);
      continue;
    }
    nodes.push(
      <span
        key={`m${key++}`}
        className={
          handle === options.viewerUsername?.toLowerCase()
            ? "bg-primary/20 text-primary rounded px-0.5 font-medium"
            : "text-primary font-medium"
        }
      >
        {match[0]}
      </span>,
    );
  }

  if (cursor < body.length) nodes.push(body.slice(cursor));
  return nodes;
}

function findMember(members: Map<string, ChatMember> | undefined, handle: string): ChatMember | undefined {
  if (!members) return undefined;
  for (const member of members.values()) {
    if (member.username.toLowerCase() === handle) return member;
  }
  return undefined;
}

/**
 * Does this message mention me?
 *
 * Derived from the body at render/notify time rather than stored in a `mention`
 * table. The table would buy a "mentions of me" inbox, which no doc asks for;
 * everything the feature actually does — highlight the token, and let a mention
 * through a muted conversation — needs only this.
 */
export function mentionsUser(body: string | null, username: string): boolean {
  if (!body) return false;
  const pattern = new RegExp(MENTION_PATTERN.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match[1].toLowerCase() === username.toLowerCase()) return true;
  }
  return false;
}
