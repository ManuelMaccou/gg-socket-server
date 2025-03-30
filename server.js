import { createServer } from "http";
import { Server } from "socket.io";

const port = process.env.PORT || 3001;
const httpServer = createServer();

const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: "https://gg-socket-server-production.up.railway.app",
    methods: ["GET", "POST"]
  }
});

const matches = {};

io.on("connection", (socket) => {
  console.log("User connected: ", socket.id);

  socket.on("join-match", ({ matchId, userName }) => {
    if (!userName) {
      console.error("User attempted to join without a username");
      return;
    }

    // If the matchId doesn't exist, create a new array for players
    if (!matches[matchId]) {
      matches[matchId] = [];
    }

    // Add the player to the match if they don't already exist
    const existingPlayer = matches[matchId].find(player => player.userName === userName);
    if (!existingPlayer) {
      matches[matchId].push({ userName, socketId: socket.id });
    }

    socket.join(matchId);

    console.log(`${userName} joined match ${matchId}`);
    
    // Emit the current player list to everyone in the room
    io.to(matchId).emit("player-list", matches[matchId]);
  });

  socket.on("submit-score", ({ matchId, score }) => {
    io.to(matchId).emit("score-update", { id: socket.id, score });
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Remove the player from the match on disconnect
    for (const matchId in matches) {
      matches[matchId] = matches[matchId].filter(player => player.socketId !== socket.id);

      // Notify remaining players about the updated list
      io.to(matchId).emit("player-list", matches[matchId]);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
});
