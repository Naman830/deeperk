/**
 * The composer's emoji picker.
 *
 * A curated list, NOT an emoji-picker dependency. `emoji-mart` and friends ship
 * roughly a megabyte with their data files, for a control that inserts a single
 * character. This covers the realistic range at zero bundle cost and no new
 * package.
 *
 * Nothing validates against it server-side — an emoji inserted here is just
 * text inside a message body, subject to the same 4000-character cap as any
 * other text, so the list can grow a row with no matching server change.
 */
export const EMOJI_GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: "Smileys",
    emoji: [
      "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣",
      "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😋",
      "😜", "🤪", "🤗", "🤔", "🤨", "😐", "😴", "😪",
    ],
  },
  {
    label: "Expressions",
    emoji: [
      "😮", "😯", "😲", "😳", "🥺", "😢", "😭", "😤",
      "😠", "😡", "🤯", "😱", "😰", "😥", "🙄", "😬",
    ],
  },
  {
    label: "Gestures",
    emoji: [
      "👍", "👎", "👌", "🤌", "✌️", "🤞", "🤝", "👏",
      "🙌", "🙏", "💪", "👋", "🫶", "🤙", "☝️", "✍️",
    ],
  },
  {
    label: "Symbols",
    emoji: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔",
      "✨", "🔥", "🎉", "🎊", "💯", "✅", "❌", "⚡",
      "⭐", "🌟", "👀", "💀", "🤍", "🩷",
    ],
  },
];
