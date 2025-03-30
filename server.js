import { createServer } from "http";
import { Server } from "socket.io";

const port = process.env.PORT || 3001;
const httpServer = createServer();

const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

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

  socket.onAny((event, ...args) => {
    console.log(`Received event: ${event}`, args);
  });

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

  socket.on("set-teams", ({ matchId, team1, team2 }) => {
    if (!matches[matchId]) return;

    matches[matchId].team1 = team1;
    matches[matchId].team2 = team2;

    io.to(matchId).emit("teams-set", { team1, team2 });
  });

  socket.on("submit-score", ({ matchId, userName, team1, team2, yourScore, opponentsScore }) => {
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
          winners: team1Score > team2Score ? team1 : team2,
        });
        io.to(matchId).emit("scores-validated", { success: true });
        console.log("⚡ 'scores-validated' event broadcasted to match room");
      } else {
        io.to(matchId).emit("scores-validated", { success: false, message: "Scores do not match. Please try again." });
        console.log("Score mismatch detected for match:", matchId);
      }
    }
  });

  socket.on("clear-scores", ({ matchId }) => {
    delete scores[matchId];
    console.log(`Scores cleared for match: ${matchId}`);
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
