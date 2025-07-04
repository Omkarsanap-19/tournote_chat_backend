const express = require("express");
const app = express();
const cors = require("cors");
const pool = require("./db");
const http = require("http");
require("dotenv").config();
const { Server } = require("socket.io");

const server = http.createServer(app);

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

// Socket.IO logic
io.on("connection", (socket) => {
  console.log(`✅ Socket connected: ${socket.id}`);

  socket.on("disconnect", (reason) => {
    console.log(`⚠️ Socket disconnected: ${socket.id} | Reason: ${reason}`);
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

      await pool.query(`DELETE FROM messages WHERE message_id = $1`, [
        message_id,
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
