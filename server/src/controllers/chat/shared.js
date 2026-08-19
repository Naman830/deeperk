// Constants shared across the chat controller's modules.

const MESSAGE_MAX_LENGTH = 4000;

// One answer for "no such conversation" and "you're not a member", so an id
// can never be probed for existence (chat.md §2.4).
const NOT_FOUND = { code: "NOT_FOUND", error: "Conversation not found." };
// Deliberately non-committal, and deliberately NOT "you are blocked". Telling
// someone they have been blocked is itself information the blocker did not
// agree to share, and it turns the block into a notification.
const BLOCKED = { code: "NOT_FOUND", error: "Couldn't send that message." };

module.exports = { MESSAGE_MAX_LENGTH, NOT_FOUND, BLOCKED };
