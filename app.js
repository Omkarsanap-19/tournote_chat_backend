const express = require("express")
const app = express();
const cors = require('cors');
const pool = require('./db');
const http = require('http')
require('dotenv').config();
const {Server} = require('socket.io');



// middleware
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Safe for Android apps
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket"]
});


app.use(cors())
app.use(express.json())
app.use(express.text())

// Global error handlers to prevent server crashes
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Log the error but don't crash the server
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Log the error but don't crash the server
});

// Database pool error handling
pool.on('error', (err, client) => {
    console.error('💥 Postgres Pool Error:', err.message);
    // Don't crash the server, just log the error
});

// Better database connection error handling
pool.on('connect', () => {
    console.log('✅ Database connected successfully');
});

// routes

// get all
app.get('/message/:grp_id',async(req,res)=>{
    try {
        const {grp_id} = req.params
        const result = await pool.query('SELECT * FROM messages WHERE group_id=$1 ORDER BY timestamp ASC',[grp_id])
        res.json(result.rows)
    } catch (error) {
        console.error('❌ Database error in GET /message:', error);
        res.status(500).json({
            status: 'error',
            error: 'Failed to fetch messages',
            debug: error.message
        });
    }
})


io.on('connection',(socket) =>{
    console.log(`new user is entered`);

    // Handle socket disconnection
    socket.on('disconnect', (reason) => {
        console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    });

    // Handle socket errors
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });

    socket.on('join_room', (payload, callback) => {
        try {
            const groupId = typeof payload === 'object' ? payload.id : payload;

            if (!groupId) {
                return callback?.({ status: 'error', error: 'Missing group ID' });
            }

            socket.join(groupId);
            console.log(`Socket ${socket.id} joined room ${groupId}`);
            callback?.({ status: 'ok', joined: groupId });

        } catch (err) {
            console.error('join_room failed:', err);
            callback?.({ status: 'error', error: err.message });
        }
    });

    socket.on('new_message', async (msg, callback) => {
        try {
            const group = msg.group_id;
            const temp = socket.to(group).emit('message_recieved', msg);
            console.log(temp);
            
            const {
                message_content,
                user_name,
                group_id,
                user_id,
                timestamp,
                edited = false,
                is_user = false,
                profile_pic,
                message_id
            } = msg;

            // Insert into PostgreSQL
            const result = await pool.query(
                `INSERT INTO messages (
                    message_id, message_content, user_name, group_id,
                    user_id, timestamp, edited, is_user, profile_pic
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    message_id,
                    message_content,
                    user_name,
                    group_id,
                    user_id,
                    timestamp,
                    edited,
                    is_user,
                    profile_pic
                ]
            );

            console.log('Message saved successfully');

            callback({
                status: 'ok',
                message_id: message_id,
                saved: true
            });
            
        } catch (error) { // Fixed: was catching 'e' but using 'error'
            console.error('❌ Database error in new_message:', error);
            callback({
                status: 'error',
                error: 'Message not saved',
                debug: error.message
            });
        }
    });

    socket.on('update_message', async (msg, callback) => {
        try {
            const group = msg.group_id;
            const temp = socket.to(group).emit('update_recieved', msg);
            console.log(temp);
            
            const {
                message_content,
                user_name,
                group_id,
                user_id,
                timestamp,
                edited = false,
                is_user = false,
                profile_pic,
                message_id
            } = msg;

            // Update into PostgreSQL
            const result = await pool.query(
                `UPDATE messages 
                SET 
                    message_content = $1,
                    timestamp = $2,
                    edited = $3
                WHERE message_id = $4`,
                [
                    message_content,
                    timestamp,
                    true,
                    message_id
                ]
            );

            console.log('Message Updated successfully');

            callback({
                status: 'ok',
                message_id: message_id,
                saved: true
            });
            
        } catch (error) { // Fixed: was catching 'e' but using 'error'
            console.error('❌ Database error in new_message:', error);
            callback({
                status: 'error',
                error: 'Message not updated',
                debug: error.message
            });
        }
    });

    socket.on('delete_message', async (msg, callback) => {
        try {
            const group = msg.group_id;
            const temp = socket.to(group).emit('delete_recieved', msg);
            console.log(temp);
            
            const {
                group_id,
                user_id,
                message_id
            } = msg;

            // Delete into PostgreSQL
            const result = await pool.query(
                `DELETE FROM messages WHERE message_id = $1`,
                [message_id]
            );


            console.log('Message Deleted successfully');

            callback({
                status: 'ok',
                message_id: message_id,
                saved: true
            });
            
        } catch (error) { // Fixed: was catching 'e' but using 'error'
            console.error('❌ Database error in new_message:', error);
            callback({
                status: 'error',
                error: 'Message not deleted',
                debug: error.message
            });
        }
    });

});

// Graceful shutdown handling
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on port ${PORT}...`);
});
