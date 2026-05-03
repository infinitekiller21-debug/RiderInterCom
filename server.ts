import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  app.use(cors());

  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Serve static assets from public folder (manifest, sw, icons)
  app.use(express.static(path.join(__dirname, 'public')));

  const PORT = 3000;

  // Store room states
  const ridersInRide: Record<string, string[]> = {};

  io.on('connection', (socket) => {
    console.log('Rider connected:', socket.id);

    socket.on('join-ride', (rideId) => {
      socket.join(rideId);
      if (!ridersInRide[rideId]) {
        ridersInRide[rideId] = [];
      }
      socket.to(rideId).emit('rider-joined', socket.id);
      const otherRiders = Array.from(io.sockets.adapter.rooms.get(rideId) || []).filter(id => id !== socket.id);
      socket.emit('ride-roster', otherRiders);
    });

    socket.on('signal', ({ to, signal }) => {
      io.to(to).emit('signal', { from: socket.id, signal });
    });

    socket.on('disconnect', () => {
      io.emit('rider-left', socket.id);
    });
  });

  // Vite Integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`RiderCast Server active on http://0.0.0.0:${PORT}`);
  });
}

startServer();
