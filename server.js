const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public')));

// ---- Matchmaking state ----
const queues = { video: [], text: [] };
const partners = new Map(); // socketId -> partnerSocketId
const rate = new Map();     // socketId -> recent message timestamps

function removeFromQueues(id) {
  for (const mode of Object.keys(queues)) {
    queues[mode] = queues[mode].filter((x) => x !== id);
  }
}

function leave(socket, notifyPartner = true) {
  removeFromQueues(socket.id);
  const pid = partners.get(socket.id);
  if (pid) {
    partners.delete(socket.id);
    partners.delete(pid);
    if (notifyPartner) io.to(pid).emit('partner-left');
  }
}

function findMatch(socket, mode) {
  if (!queues[mode]) return;
  leave(socket, true);

  const queue = queues[mode];
  while (queue.length) {
    const otherId = queue.shift();
    const other = io.sockets.sockets.get(otherId);
    if (!other || otherId === socket.id) continue;

    partners.set(socket.id, otherId);
    partners.set(otherId, socket.id);
    // The user who waited longest creates the WebRTC offer
    other.emit('matched', { initiator: true });
    socket.emit('matched', { initiator: false });
    return;
  }
  queue.push(socket.id);
  socket.emit('waiting');
}

function allowMessage(id) {
  const now = Date.now();
  const list = (rate.get(id) || []).filter((t) => now - t < 3000);
  if (list.length >= 5) return false;
  list.push(now);
  rate.set(id, list);
  return true;
}

function broadcastOnline() {
  io.emit('online', io.engine.clientsCount);
}

// ---- Socket events ----
io.on('connection', (socket) => {
  broadcastOnline();

  socket.on('find', ({ mode } = {}) => findMatch(socket, mode));

  socket.on('stop', () => leave(socket, true));

  // WebRTC signaling relay (offer / answer / ICE candidates)
  socket.on('signal', (data) => {
    const pid = partners.get(socket.id);
    if (pid) io.to(pid).emit('signal', data);
  });

  socket.on('message', (text) => {
    const pid = partners.get(socket.id);
    if (!pid || typeof text !== 'string') return;
    if (!allowMessage(socket.id)) return;
    const clean = text.trim().slice(0, 1000);
    if (clean) io.to(pid).emit('message', clean);
  });

  socket.on('typing', (isTyping) => {
    const pid = partners.get(socket.id);
    if (pid) io.to(pid).emit('typing', !!isTyping);
  });

  socket.on('report', () => {
    const pid = partners.get(socket.id);
    if (pid) {
      // Hook this into your moderation pipeline (store reporter, reported id, timestamp, etc.)
      console.log(`[report] ${socket.id} reported ${pid} at ${new Date().toISOString()}`);
    }
  });

  socket.on('disconnect', () => {
    leave(socket, true);
    rate.delete(socket.id);
    broadcastOnline();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Omelette is cooking on http://localhost:${PORT}`));
