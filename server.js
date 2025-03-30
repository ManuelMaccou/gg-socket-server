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

const players = {};

io.on("connection", (socket) => {
  console.log("User connected: ", socket.id);

  socket.on("join-match", ({ matchId, userName }) => {
    if (!userName) {
      console.error("User attempted to join without a username");
      return;
    }

    players[socket.id] = { userName, matchId };
    socket.join(matchId);

    console.log(`${userName} joined match ${matchId}`);
    io.to(matchId).emit("player-joined", { id: socket.id, userName });
  });

  socket.on("submit-score", ({ matchId, score }) => {
    io.to(matchId).emit("score-update", { id: socket.id, score });
  });

  socket.on("disconnect", () => {
    const player = players[socket.id];
    if (player) {
      console.log(`${player.userName} disconnected from match ${player.matchId}`);
      delete players[socket.id];
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
});
