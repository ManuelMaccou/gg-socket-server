import 'dotenv/config'
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";

const port = process.env.PORT || 3001;
const httpServer = createServer();
const apiUrl = process.env.API_URL?.replace(/\/$/, '');

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
    console.error('POSTing to:', `${apiUrl}/api/user/get-dupr-status`);
    console.log('Using headers:', { 'x-api-key': process.env.INTERNAL_API_KEY });
    console.error('Payload:', { userIds: allPlayerIds });

    const duprCheckRes = await axios.post(`${apiUrl}/api/user/get-dupr-status`, {
      userIds: allPlayerIds
    });

    const { users } = duprCheckRes.data;
    const allDuprActivated = users.every((u) => u.dupr?.activated === true);

    // --- Step 3: Save the Match ---
    console.error('POSTing to:', `${apiUrl}/api/match`);
    console.log('Using headers:', { 'x-api-key': process.env.INTERNAL_API_KEY });
    console.error('Payload:', {
      matchId,
      team1: { players: team1Ids, score: team1Score },
      team2: { players: team2Ids, score: team2Score },
      winners,
      location,
      ...(allDuprActivated && { logToDupr: true })
    });

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
      console.error('Full error response:', {
      status: error.response.status,
      headers: error.response.headers,
      data: error.response.data,
    });

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
    // --- Logging added for debugging ---
    console.log(`[${matchId}] Score received from ${userName}: Your Score ${yourScore}, Opponent's Score ${opponentsScore}`);

    if (!scores[matchId]) scores[matchId] = {};
    
    // 1. ParseInt immediately and store the score
    scores[matchId][userName] = { 
        yourScore: parseInt(yourScore, 10), 
        opponentsScore: parseInt(opponentsScore, 10) 
    };

    // 2. THIS IS THE BUG FIX: Convert the scores object to an array, preserving the userName
    const allSubmittedScores = Object.entries(scores[matchId]).map(([uName, scoreData]) => ({
      userName: uName,
      ...scoreData
    }));

    const expectedPlayerCount = matches[matchId]?.length || 4;

    // --- Logging added for debugging ---
    console.log(`[${matchId}] ${allSubmittedScores.length} of ${expectedPlayerCount} scores submitted.`);

    if (allSubmittedScores.length === expectedPlayerCount) {
      // --- Logging added for debugging ---
      console.log(`[${matchId}] All scores received. Starting validation...`);
      console.log(`[${matchId}] Full submitted score data:`, allSubmittedScores);

      const team1Scores = allSubmittedScores.filter(player => team1.includes(player.userName));
      const team2Scores = allSubmittedScores.filter(player => team2.includes(player.userName));

      // --- Logging added for debugging ---
      console.log(`[${matchId}] Filtered Team 1 Scores:`, team1Scores);
      console.log(`[${matchId}] Filtered Team 2 Scores:`, team2Scores);

      // 3. Check for intra-team agreement first, with safety checks
      const team1Valid = team1Scores.length > 0 && team1Scores.every(p => 
        p.yourScore === team1Scores[0].yourScore && p.opponentsScore === team1Scores[0].opponentsScore
      );
      const team2Valid = team2Scores.length > 0 && team2Scores.every(p => 
        p.yourScore === team2Scores[0].yourScore && p.opponentsScore === team2Scores[0].opponentsScore
      );

      // --- Logging added for debugging ---
      console.log(`[${matchId}] Intra-team agreement check -> Team 1 Valid: ${team1Valid}, Team 2 Valid: ${team2Valid}`);

      if (!team1Valid || !team2Valid) {
        // --- Logging added for debugging ---
        console.error(`[${matchId}] ❌ FAILURE: Intra-team scores do not match. Emitting error to client.`);
        return io.to(matchId).emit("scores-validated", { success: false, message: "Scores within a team do not match. Please try again." });
      }

      // 4. Use the concise cross-agreement check
      const crossAgree = 
        team1Scores[0].yourScore === team2Scores[0].opponentsScore &&
        team1Scores[0].opponentsScore === team2Scores[0].yourScore;

      // --- Logging added for debugging ---
      console.log(`[${matchId}] Cross-team agreement check -> Match: ${crossAgree}`);
      
      if (crossAgree) {
        // SUCCESS!
        const team1Score = team1Scores[0].yourScore;
        const team2Score = team2Scores[0].yourScore;

        // --- Logging added for debugging ---
        console.log(`[${matchId}] ✅ SUCCESS: All scores match. Final validated score: ${team1Score}-${team2Score}`);

        scores[matchId].final = { team1, team2, team1Score, team2Score, location };
        io.to(matchId).emit("scores-validated", { success: true });
        handleMatchSave(matchId, io);

      } else {
        // --- Logging added for debugging ---
        console.error(`[${matchId}] ❌ FAILURE: Cross-team scores do not match. Emitting error to client.`);
        io.to(matchId).emit("scores-validated", { success: false, message: "The scores submitted by the two teams do not match. Please confirm and resubmit." });
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
