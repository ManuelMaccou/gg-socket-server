import { createServer } from "http";
import { Server } from "socket.io";

const port = process.env.PORT || 3001;
const httpServer = createServer();

const roomTimers = {};
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

function logRoomState(io, matchId) {
  const room = io.sockets.adapter.rooms.get(matchId);
  const socketIds = room ? Array.from(room) : [];

  console.log(`📊 Room [${matchId}] State:`);
  console.log(`  • Active socket IDs in room:`, socketIds);

  for (const socketId of socketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      console.log(`  → Socket ${socket.id} is connected: ${socket.connected}`);
      console.log(`    • Registered events:`, Array.from(socket.eventNames()));
    }
  }

  console.log("📉 Total rooms on server:", Array.from(io.sockets.adapter.rooms.keys()));
  console.log("📉 Total connected sockets:", io.engine.clientsCount);
}


/*
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: [
      "http://localhost:3000",
      "https://ggpickleball.co",
      "https://gg-socket-server-production.up.railway.app"
    ],
    methods: ["GET", "POST"]
  }
});
*/

const matches = {};
const scores = {};

io.on("connection", (socket) => {
  console.log("User connected: ", socket.id);

  console.log(`Initial rooms for socket ${socket.id}: ${Array.from(socket.rooms).join(", ")}`);

  socket.onAny((event, ...args) => {
    console.log(`Received event: ${event}`, args);
  });

  socket.on("join-match", ({ matchId, userName, userId }) => {
    console.log(`Rooms for socket ${socket.id} after joining: ${Array.from(socket.rooms).join(", ")}`);

    if (!userName) {
      console.error("User attempted to join without a username");
      return;
    }

    if (!userId) {
      console.error("User attempted to join without a user ID");
      return;
    }

    // If the matchId doesn't exist, create a new array for players
    if (!matches[matchId]) {
      matches[matchId] = [];

      // Start 1-hour expiration timer for this match
      roomTimers[matchId] = setTimeout(() => {
        console.log(`⏰ Match ${matchId} expired after 1 hour.`);
  
        // Cleanup state
        delete matches[matchId];
        delete scores[matchId];
        delete roomTimers[matchId];

        logRoomState(io, matchId);
  
        // Broadcast expiration to all clients still in the room
        io.to(matchId).emit("room-expired", { matchId });
      // }, 60 * 60 * 1000); // 1 hour
      // }, 60 * 1000); // 60 seconds
      }, 10 * 1000); // 10 seconds

    }

    // Add the player to the match if they don't already exist
    const existingPlayer = matches[matchId].find(player => player.userName === userName);
    if (!existingPlayer) {
      matches[matchId].push({ userName, userId, socketId: socket.id });  // Include userId here
    }

    socket.join(matchId);
    console.log(`${userName} joined match ${matchId}`);
    console.log(`🔍 Current rooms for socket ${socket.id}: ${Array.from(socket.rooms).join(", ")}`);
    
    // Emit the current player list to everyone in the room
    io.to(matchId).emit("player-list", matches[matchId]);
  });

  socket.on("set-teams", ({ matchId, team1, team2 }) => {
    if (!matches[matchId]) return;

    matches[matchId].team1 = team1;
    matches[matchId].team2 = team2;

    io.to(matchId).emit("teams-set", { team1, team2 });
  });

  socket.on("submit-score", ({ matchId, userName, team1, team2, yourScore, opponentsScore, location }) => {
    if (!matches[matchId]) {
      socket.emit("room-expired", { matchId });
      console.warn(`⚠️ Score submission blocked: Match ${matchId} is expired or missing.`);
      return;
    }

    console.log("Location received in submit-score:", location);
    if (!scores[matchId]) scores[matchId] = {};
    
    scores[matchId][userName] = { yourScore, opponentsScore };

    const allScores = Object.keys(scores[matchId]).map(key => ({
      userName: key,
      ...scores[matchId][key]
    }));

    console.log("All scores:", allScores);

    if (allScores.length === 4) {  // All players have submitted scores
      const team1Scores = allScores.filter(player => team1.includes(player.userName));
      console.log("Team 1 scores:", team1Scores);

      const team2Scores = allScores.filter(player => team2.includes(player.userName));
      console.log("Team 2 scores:", team2Scores);

      const team1Valid = team1Scores.every(player => 
        player.yourScore === team1Scores[0].yourScore &&
        player.opponentsScore === team1Scores[0].opponentsScore
      );
      console.log("Team 1 valid:", team1Valid);

      const team2Valid = team2Scores.every(player => 
        player.yourScore === team2Scores[0].yourScore &&
        player.opponentsScore === team2Scores[0].opponentsScore
      );
      console.log("Team 2 valid:", team2Valid);

      if (team1Valid && team2Valid) {
        const team1Score = parseInt(yourScore, 10);
        const team2Score = parseInt(opponentsScore, 10);

        console.log(`✅ Scores validated successfully for match: ${matchId}`);
        console.log(`Emitting 'save-match' event to client with socket.id: ${socket.id}`);

        io.to(socket.id).emit("save-match", { 
          success: true,
          matchId,
          team1,
          team2,
          team1Score,
          team2Score,
          location,
        });
        io.to(matchId).emit("scores-validated", { success: true });
        console.log("⚡ 'scores-validated' event broadcasted to match room");
      } else {
        io.to(matchId).emit("scores-validated", { success: false, message: "Scores do not match. Please try again." });
        console.log("Score mismatch detected for match:", matchId);
      }
    }
  });

  socket.on("match-saved", ({ matchId }) => {
    if (roomTimers[matchId]) {
      clearTimeout(roomTimers[matchId]);
      delete roomTimers[matchId];
    }
  
    // Optionally: also clear match/scores to free memory
    delete matches[matchId];
    delete scores[matchId];

    console.log(`✅ Match ${matchId} successfully saved. Broadcasting to all clients.`);
    io.to(matchId).emit("match-saved", { success: true, message: "Match successfully saved!" });
  });

  socket.on("clear-scores", ({ matchId }) => {
    delete scores[matchId];
    console.log(`Scores cleared for match: ${matchId}`);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    console.log(`Active rooms for socket ${socket.id}: ${Array.from(socket.rooms).join(", ")}`);

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
