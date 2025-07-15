const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const http = require("http");
const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");
require("dotenv").config();
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const firebaseApp = admin.initializeApp({
  credential: admin.credential.cert(
    require(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ),
  databaseURL: `https://${process.env.PROJECT_ID}-default-rtdb.firebaseio.com`,
});

const server = http.createServer(app);
const onlineUsers = new Map(); // user_id → socket.id

const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (ideal for Android testing)
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket"], // Force WebSocket transport
});

// Middleware
app.use(cors());
app.use(express.json());

const PROJECT_ID = process.env.PROJECT_ID;
const SCOPES = ["https://www.googleapis.com/auth/firebase.messaging"];


const auth = new GoogleAuth({
  keyFile:process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: SCOPES,
});

// Handle uncaught exceptions
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection:", reason);
});

// PostgreSQL pool logs
pool.on("error", (err) => {
  console.error("💥 Postgres Pool Error:", err.message);
});
pool.on("connect", () => {
  console.log("✅ Database connected successfully");
});

// send notification function

async function getGroupNameFromFirebase(groupId) {
  const ref = admin.database().ref(`groups/${groupId}/GroupDetails/name`);
  const snapshot = await ref.once("value");
  return snapshot.val(); // returns "test 1234"
}


async function sendFcmNotification(targetUserId, messageContent,groupId) {
  try {
    const result = await pool.query(
      `SELECT token FROM fcm_tokens WHERE user_id = $1 LIMIT 1`,
      [targetUserId]
    );

    const token = result.rows[0]?.token;
    if (!token) {
      console.warn(`⚠️ No FCM token for user ${targetUserId}`);
      return;
    }

    const grpName = await getGroupNameFromFirebase(groupId) || "Group Chat";


    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
    

    const notificationPayload = {
      message: {
        token,
        notification: {
          title: `New message in ${grpName}`,
          body: messageContent,
        },
        data: {
          title: `New message in ${grpName}`,
          body: messageContent,
          group_id: String(groupId),
          click_action: "FLUTTER_NOTIFICATION_CLICK"
        },
      },
    };


    const response = await axios.post(url, notificationPayload, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        "Content-Type": "application/json",
      },
    });
    console.log("📤 Push notification sent:");
  } catch (error) {
    console.error("❌ Failed to send FCM notification:", error);
  }
}

async function sendAlertNotification(targetUserId,groupId,userName,grpName) {
  try {
    const result = await pool.query(
      `SELECT token FROM fcm_tokens WHERE user_id = $1 LIMIT 1`,
      [targetUserId]
    );

    const token = result.rows[0]?.token;
    if (!token) {
      console.warn(`⚠️ No FCM token for user ${targetUserId}`);
      return;
    }


    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    const url = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
    

    const notificationPayload = {
      message: {
        token,
        notification: {
          title: `Alert from ${userName} of the ${grpName}`,
          body: "",
        },
        data: {
          title: `Alert from ${userName} of the ${grpName}`,
          body: "",
          group_id: String(groupId),
          click_action: "FLUTTER_NOTIFICATION_CLICK"
        },
      },
    };


    const response = await axios.post(url, notificationPayload, {
      headers: {
        Authorization: `Bearer ${accessToken.token}`,
        "Content-Type": "application/json",
      },
    });
    console.log("📤 Push notification sent:");
  } catch (error) {
    console.error("❌ Failed to send FCM notification:", error);
  }
}
// Get messages for a group
app.get("/message/:grp_id", async (req, res) => {
  try {
    const { grp_id } = req.params;
    const result = await pool.query(
      "SELECT * FROM messages WHERE group_id=$1 ORDER BY timestamp ASC",
      [grp_id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Error in GET /message:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

//post alert

app.post('/showAlert',async(req,res)=>{
  try {
    const {userName,userId,grpName,grpId} = req.body;
    if (!userId || !userName || !grpName || !grpId) {
      return res.status(400).json({
        success: false,
        error: "Missing required information",
      });
    }

    const groupUsers = await pool.query(
  `SELECT DISTINCT user_id
FROM messages
WHERE group_id = $1`,
  [grpId]
);

for (const row of groupUsers.rows) {
  const recipientId = row.user_id;

  // Don't notify the sender
  if (recipientId === userId) continue;

  // Send push to offline user
  await sendAlertNotification(recipientId, grpId,userName,grpName);
}


  } catch (error) {
    console.error("❌ Error in POST /alert:", error);
    res.status(500).json({ error: "Failed to post alert" });
  }
})

//save fcm logic

app.post('/saveToken', async (req, res) => {
  try {
    const { token, user_id } = req.body;

    if (!token || !user_id) {
      return res.status(400).json({
        success: false,
        error: "Missing token or user_id",
      });
    }

    const result = await pool.query(
      `INSERT INTO fcm_tokens (user_id, token)
       VALUES ($1, $2)
       ON CONFLICT (token)
       DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [user_id, token]
    );

    res.status(200).json({
      success: true,
      message: "FCM token updated successfully",
      data: {
        user_id: result.rows[0].user_id,
        token: result.rows[0].token,
        updated_at: result.rows[0].updated_at,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error("Token update failed:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving FCM token",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});


// Socket.IO logic
io.on("connection", (socket) => {
  console.log(`✅ Socket connected: ${socket.id}`);

socket.on("disconnect", () => {
  // Remove any matching user_id
  for (const [userId, sid] of onlineUsers.entries()) {
    if (sid === socket.id) {
      onlineUsers.delete(userId);
      console.log(`🟡 User ${userId} went offline`);
    }
  }
});


  socket.on("error", (error) => {
    console.error("⚠️ Socket error:", error);
  });

  socket.on("join_room", (payload, callback) => {
    try {
      const groupId = typeof payload === "object" ? payload.id : payload;

      if (!groupId) {
        return callback?.({ status: "error", error: "Missing group ID" });
      }

      socket.join(groupId);
      console.log(`🚪 Socket ${socket.id} joined room ${groupId}`);
      callback?.({ status: "ok", joined: groupId });
    } catch (err) {
      console.error("❌ join_room failed:", err);
      callback?.({ status: "error", error: err.message });
    }
  });

  socket.on("register_user", (user_id) => {
  if (user_id) {
    onlineUsers.set(user_id, socket.id);
    console.log(`✅ Registered user ${user_id} as online [${socket.id}]`);
  }
});


  socket.on("new_message", async (msg, callback) => {
    try {
      const {
        message_content,
        user_name,
        group_id,
        user_id,
        timestamp,
        edited = false,
        is_user = false,
        profile_pic,
        message_id,
      } = msg;

      // Save to DB first
      await pool.query(
        `INSERT INTO messages (
          message_id, message_content, user_name, group_id,
          user_id, timestamp, edited, is_user, profile_pic
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          message_id,
          message_content,
          user_name,
          group_id,
          user_id,
          timestamp,
          edited,
          is_user,
          profile_pic,
        ]
      );

      console.log(`💬 Message saved for group ${group_id}: ${message_content}`);

      // Emit to all in the group (excluding sender)
      socket.to(group_id).emit("message_recieved", msg);

        // NEW: Send push notifications to all users in group except sender
const groupUsers = await pool.query(
  `SELECT DISTINCT user_id
FROM messages
WHERE group_id = $1`,
  [group_id]
);

for (const row of groupUsers.rows) {
  const recipientId = row.user_id;

  // Don't notify the sender
  if (recipientId === user_id) continue;

  // Skip online users
  if (onlineUsers.has(recipientId)) {
    console.log(`🟢 Skipping push: ${recipientId} is online`);
    continue;
  }

  // Send push to offline user
  await sendFcmNotification(recipientId, message_content,group_id);
}

      callback?.({ status: "ok", saved: true, message_id });
    } catch (error) {
      console.error("❌ Error saving message:", error);
      callback?.({
        status: "error",
        error: "Message not saved",
        debug: error.message,
      });
    }
  });

  socket.on("update_message", async (msg, callback) => {
    try {
      const {
        message_content,
        timestamp,
        message_id,
        group_id,
      } = msg;

      await pool.query(
        `UPDATE messages 
         SET message_content = $1, timestamp = $2, edited = true
         WHERE message_id = $3`,
        [message_content, timestamp, message_id]
      );

      console.log(`✏️ Message updated in group ${group_id}`);

      socket.to(group_id).emit("update_recieved", msg);

      callback?.({ status: "ok", saved: true, message_id });
    } catch (error) {
      console.error("❌ Error updating message:", error);
      callback?.({ status: "error", error: "Update failed" });
    }
  });

  socket.on("delete_message", async (msg, callback) => {
    try {
      const { message_id, group_id } = msg;

      await pool.query(`UPDATE messages 
         SET message_content = $1 WHERE message_id = $2`, [
        "⊘ Message Deleted.",message_id
      ]);

      console.log(`🗑️ Message deleted in group ${group_id}`);

      socket.to(group_id).emit("delete_recieved", msg);

      callback?.({ status: "ok", saved: true, message_id });
    } catch (error) {
      console.error("❌ Error deleting message:", error);
      callback?.({ status: "error", error: "Delete failed" });
    }
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received. Shutting down.");
  server.close(() => {
    console.log("Server closed");
    pool.end(() => {
      console.log("DB pool closed");
      process.exit(0);
    });
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
