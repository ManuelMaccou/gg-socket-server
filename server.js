import 'dotenv/config'
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";

const port = process.env.PORT || 3001;
const httpServer = createServer();
const apiUrl = process.env.API_URL;

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

async function handleMatchSave(matchId, io) {
  const matchData = matches[matchId];
  const scoreData = scores[matchId]?.final;
  const room = matchId; // The room name is the matchId

  if (!matchData || !scoreData) {
    console.error(`❌ Save requested for match ${matchId}, but data is missing.`);
    return io.to(room).emit("match-saved", {
        success: false,
        message: "Server error: Match or score data is missing. Please refresh.",
        matchId: matchId,
        earnedAchievements: []
    });
  }

  // Set a lock to prevent this from running more than once
  if (matchData.isSaving) return;

  matchData.isSaving = true;

  try {
      if (!apiUrl) throw new Error("API_URL environment variable is not set!");

    const { team1, team2, team1Score, team2Score, location } = scoreData;
    const players = matchData; // Use the player list from the server's state

    // --- Step 1: Prepare Match Data ---
    const getPlayerIds = (playerNames) => {
        return players
            .filter(player => playerNames.includes(player.userName))
            .map(player => player.userId);
    };

    const team1Ids = getPlayerIds(team1);
    const team2Ids = getPlayerIds(team2);
    const allPlayerIds = [...new Set([...team1Ids, ...team2Ids])];
    const winners = team1Score > team2Score ? team1Ids : team2Ids;

    // --- Step 2: Check DUPR Status (Example with a placeholder URL) ---
    const duprCheckRes = await axios.post(`${apiUrl}/api/user/get-dupr-status`, {
      userIds: allPlayerIds
    });

    const { users } = duprCheckRes.data;
    const allDuprActivated = users.every((u) => u.dupr?.activated === true);

    // --- Step 3: Save the Match ---

    const matchResponse = await axios.post(`${apiUrl}/api/match`, {
      matchId,
      team1: { players: team1Ids, score: team1Score },
      team2: { players: team2Ids, score: team2Score },
      winners,
      location,
      ...(allDuprActivated && { logToDupr: true })
    },
      {
        headers: {
          'x-api-key': process.env.INTERNAL_API_KEY,
        }
      }
    );

    const newMatchId = matchResponse.data?.match?._id;
    if (!newMatchId) {
      // This is for the edge case where the API gives a 200 OK but bad data.
      throw new Error("API returned a success status but was missing the match ID.");
    }

    // --- SUCCESS! NOW TELL THE CLIENT TO DO THE HEAVY LIFTING ---
    io.to(room).emit("match-save-successful", {
      // Pass all the data the client's `updateUserAndAchievements` function will need
      team1Ids,
      team2Ids,
      winners,
      location,
      newMatchId,
      team1Score,
      team2Score
    });

  } catch (error) {
    let errorMessage = "An unknown server error occurred.";
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx (e.g., 404, 500)
      console.error(`❌ API Error for match ${matchId}:`, error.response.data);
      // Use the error message from the API if it exists
      errorMessage = error.response.data.error || `API responded with status ${error.response.status}`;
    } else if (error.request) {
      // The request was made but no response was received (e.g., network error)
      console.error(`❌ Network Error for match ${matchId}:`, error.message);
      errorMessage = "Could not connect to the API service.";
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error(`❌ Error setting up request for match ${matchId}:`, error.message);
      errorMessage = error.message;
    }

    io.to(room).emit("match-saved", {
        success: false,
        message: errorMessage,
        matchId: matchId,
        earnedAchievements: []
    });
    
    if(matches[matchId]) delete matches[matchId].isSaving;
  }
}

io.on("connection", (socket) => {

  socket.on("join-match", ({ matchId, userName, userId }) => {

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
    }

    // Add the player to the match if they don't already exist
    const existingPlayer = matches[matchId].find(player => player.userName === userName);
    if (!existingPlayer) {
      matches[matchId].push({ userName, userId, socketId: socket.id });  // Include userId here
    }

    socket.join(matchId);
    
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
    if (!scores[matchId]) scores[matchId] = {};
    
    scores[matchId][userName] = { yourScore, opponentsScore };

    const allScores = Object.keys(scores[matchId]).map(key => ({
      userName: key,
      ...scores[matchId][key]
    }));

    if (allScores.length === 4) {  // All players have submitted scores
      const team1Scores = allScores.filter(player => team1.includes(player.userName));
      const team2Scores = allScores.filter(player => team2.includes(player.userName));
      const team1Valid = team1Scores.every(player => 
        player.yourScore === team1Scores[0].yourScore &&
        player.opponentsScore === team1Scores[0].opponentsScore
      );

      const team2Valid = team2Scores.every(player => 
        player.yourScore === team2Scores[0].yourScore &&
        player.opponentsScore === team2Scores[0].opponentsScore
      );

      if (team1Valid && team2Valid) {
        const team1Score = parseInt(yourScore, 10);
        const team2Score = parseInt(opponentsScore, 10);

        if (!scores[matchId]) scores[matchId] = {};
        scores[matchId].final = {
            team1,
            team2,
            team1Score,
            team2Score,
            location
        };

        io.to(matchId).emit("scores-validated", { success: true });

        // Server initiates the core save process automatically and only ONCE.
        handleMatchSave(matchId, io);

      } else {
        io.to(matchId).emit("scores-validated", { success: false, message: "Scores do not match. Please try again." });
      }
    }
  });

  // This listener handles the race to claim the final task.
  socket.on("claim-achievement-update-task", ({ matchId, data }) => {
    if (matches[matchId] && matches[matchId].achievementTaskClaimed) return;
    
    if (matches[matchId]) {
      matches[matchId].achievementTaskClaimed = true;
      // Send private permission to the winner of the race.
      io.to(socket.id).emit("permission-granted-for-update", data);
    }
  });

  // This listener handles the final result from the one "chosen" client.
  socket.on("client-finished-updates", ({ matchId, earnedAchievements, errorMessage }) => {
    const room = matchId;
    const finalEventData = errorMessage ? {
      success: true, message: "Match saved, but there was an issue updating achievements.",
      matchId, earnedAchievements: [], partialFailure: true
    } : {
      success: true, message: "Match and achievements successfully saved!",
      matchId, earnedAchievements: earnedAchievements || []
    };
    
    io.to(room).emit("match-saved", finalEventData);
    
    // Final cleanup
    io.to(room).emit("clear-scores", { matchId });
    delete scores[matchId];
    delete matches[matchId];
  });

  socket.on("clear-scores", ({ matchId }) => {
    delete scores[matchId];
  });

  socket.on("disconnect", () => {

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
