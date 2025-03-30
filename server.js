import { createServer } from "http";
import { Server } from "socket.io";

const port = process.env.PORT || 3001;
const httpServer = createServer();

const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: "*",  // Update this to your Next.js app's URL when deployed
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("User connected: ", socket.id);

  socket.on("join-match", (matchId) => {
    socket.join(matchId);
    io.to(matchId).emit("player-joined", { id: socket.id });
  });

  socket.on("submit-score", ({ matchId, score }) => {
    io.to(matchId).emit("score-update", { id: socket.id, score });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected: ", socket.id);
  });
});

httpServer.listen(port, () => {
  console.log(`Socket.IO server running on port ${port}`);
});
