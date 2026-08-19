const { registerSendHandler } = require("./send");
const { registerDeleteHandlers } = require("./delete");
const { registerEditHandler } = require("./edit");
const { registerReceiptHandlers } = require("./receipts");
const { registerTypingHandlers } = require("./typing");

// The chat controller: one module per concern, registered together. Callers
// require("../controllers/chat") — the folder index keeps that specifier stable.
function registerChatHandlers(io, socket) {
  registerSendHandler(io, socket);
  registerDeleteHandlers(io, socket);
  registerEditHandler(io, socket);
  registerReceiptHandlers(io, socket);
  registerTypingHandlers(io, socket);
}

module.exports = { registerChatHandlers };
