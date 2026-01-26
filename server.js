const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3001;

// Store guests and their buzz times
let guests = new Map(); // name -> socket id
let buzzRecords = []; // { name, time, timestamp }
let roundStartTime = null;
let isRoundActive = false; // Only allow buzzing when round is active

app.use(express.static('public'));

// Get local IP for QR code
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Generate QR code endpoint
app.get('/qrcode', async (req, res) => {
  // Use request host header for public URL, fallback to local IP for development
  const host = req.get('host');
  const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
  const url = host.includes('localhost') || host.match(/^\d+\.\d+\.\d+\.\d+/)
    ? `http://${getLocalIP()}:${PORT}`
    : `${protocol}://${host}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300 });
    res.json({ qrcode: qrDataUrl, url });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Guest registers their name
  socket.on('register', (name) => {
    if (name && name.trim()) {
      const trimmedName = name.trim();
      guests.set(trimmedName, socket.id);
      socket.guestName = trimmedName;
      socket.emit('registered', { success: true, name: trimmedName });
      io.emit('guestCount', guests.size);
      console.log(`Guest registered: ${trimmedName}`);
    }
  });

  // Guest buzzes in
  socket.on('buzz', () => {
    if (!socket.guestName) return;

    // Check if round is active
    if (!isRoundActive) {
      socket.emit('buzzResult', { success: false, message: '請等待主持人開始' });
      return;
    }

    // Check if this guest already buzzed
    const alreadyBuzzed = buzzRecords.some(r => r.name === socket.guestName);
    if (alreadyBuzzed) {
      socket.emit('buzzResult', { success: false, message: '你已經搶答過了' });
      return;
    }

    const now = Date.now();
    const responseTime = now - roundStartTime;
    buzzRecords.push({
      name: socket.guestName,
      time: responseTime,
      timestamp: now
    });

    // Sort by time
    buzzRecords.sort((a, b) => a.time - b.time);

    socket.emit('buzzResult', {
      success: true,
      position: buzzRecords.findIndex(r => r.name === socket.guestName) + 1
    });

    // Broadcast updated records to host
    io.emit('buzzUpdate', buzzRecords);
    console.log(`Buzz from ${socket.guestName}: ${responseTime}ms`);
  });

  // Host starts the round
  socket.on('startRound', () => {
    buzzRecords = [];
    roundStartTime = Date.now();
    isRoundActive = true;
    io.emit('buzzUpdate', buzzRecords);
    io.emit('roundStarted');
    console.log('Round started');
  });

  // Host clears records for new round
  socket.on('clearRecords', () => {
    buzzRecords = [];
    roundStartTime = null;
    isRoundActive = false;
    io.emit('buzzUpdate', buzzRecords);
    io.emit('recordsCleared');
    console.log('Records cleared, waiting for next round');
  });

  // Host requests current state
  socket.on('getState', () => {
    socket.emit('buzzUpdate', buzzRecords);
    socket.emit('guestCount', guests.size);
    socket.emit('roundState', isRoundActive);
  });

  socket.on('disconnect', () => {
    if (socket.guestName) {
      guests.delete(socket.guestName);
      io.emit('guestCount', guests.size);
      console.log(`Guest disconnected: ${socket.guestName}`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Local network: http://${ip}:${PORT}`);
  console.log(`Host page: http://${ip}:${PORT}/host.html`);
});
