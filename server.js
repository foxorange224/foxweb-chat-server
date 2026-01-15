// server.js - FoxWeb Chat Backend v5.0
'use strict';

// ===== CONFIGURACIÓN =====
const CONFIG = {
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    MAX_MESSAGES: 1000,
    MAX_USERNAME_LENGTH: 20,
    MIN_USERNAME_LENGTH: 2,
    MESSAGES_PER_PAGE: 50,
    TYPING_TIMEOUT: 5000,
    HEARTBEAT_INTERVAL: 30000,
    ROOM: 'general',
    // Permitir conexiones desde Cloudflare Pages
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'https://foxweb.pages.dev'
};

// ===== DEPENDENCIAS =====
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

// ===== INICIALIZACIÓN =====
const app = express();
const server = http.createServer(app);

// Configurar Socket.IO con CORS para Cloudflare Pages
const io = socketIo(server, {
    cors: {
        origin: CONFIG.CORS_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// ===== MIDDLEWARE =====
app.use(cors({
    origin: CONFIG.CORS_ORIGIN
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== ENDPOINTS PARA RENDER =====

// 1. Endpoint CRÍTICO para mantener activo en Render
app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'online',
        uptime: process.uptime(),
        timestamp: Date.now(),
        onlineUsers: Object.keys(connectedUsers).length,
        messages: messageHistory.length,
        server: 'FoxWeb Chat Backend v5.0'
    });
});

// 2. Health check para Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// 3. Estado del servidor
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        users: Object.keys(connectedUsers).length,
        messages: messageHistory.length,
        uptime: process.uptime(),
        version: '5.0'
    });
});

// 4. Ruta principal (información)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>FoxWeb Chat Backend</title>
            <style>
                body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                .success { color: green; }
            </style>
        </head>
        <body>
            <h1 class="success">✅ FoxWeb Chat Backend v5.0</h1>
            <p>Este es el servidor backend para el chat en tiempo real.</p>
            <p>El frontend está en <a href="https://foxweb.pages.dev/chat">https://foxweb.pages.dev/chat</a></p>
            <p><strong>Estado:</strong> En línea | <strong>Usuarios conectados:</strong> ${Object.keys(connectedUsers).length} | <strong>Mensajes en memoria:</strong> ${messageHistory.length}</p>
            <p><a href="/ping">Ver detalles del servidor</a></p>
        </body>
        </html>
    `);
});

// ===== ESTADO DEL SERVIDOR =====
const connectedUsers = {};
let messageHistory = [];
const typingUsers = new Set();

// ===== FUNCIONES DE UTILIDAD =====
const utils = {
    isValidUsername: (username) => {
        if (!username || typeof username !== 'string') return false;
        const clean = username.trim();
        return clean.length >= CONFIG.MIN_USERNAME_LENGTH &&
               clean.length <= CONFIG.MAX_USERNAME_LENGTH &&
               /^[a-zA-Z0-9_\- ]+$/.test(clean);
    },

    isValidMessage: (message) => {
        return message &&
               typeof message === 'string' &&
               message.trim().length > 0 &&
               message.length <= 2000;
    },

    generateAvatarColor: (username) => {
        const colors = ['#FF6B6B', '#4ECDC4', '#FFD166', '#06D6A0', '#118AB2',
                       '#7209B7', '#F72585', '#FF9A8B', '#42E695', '#667EEA'];
        let hash = 0;
        for (let i = 0; i < (username || '').length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    },

    formatTime: (date) => {
        const d = new Date(date);
        const hours = d.getHours().toString().padStart(2, '0');
        const minutes = d.getMinutes().toString().padStart(2, '0');
        const seconds = d.getSeconds().toString().padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    },

    generateId: () => {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    },

    cleanupInactiveUsers: () => {
        const now = Date.now();
        const inactiveThreshold = 2 * 60 * 1000; // 2 minutos

        Object.keys(connectedUsers).forEach(socketId => {
            const user = connectedUsers[socketId];
            if (now - (user.lastActivity || 0) > inactiveThreshold) {
                console.log(`🕒 Usuario inactivo removido: ${user.username}`);
                
                typingUsers.delete(user.username);
                
                io.to(CONFIG.ROOM).emit('userLeft', {
                    username: user.username,
                    userId: user.userId,
                    onlineCount: Object.keys(connectedUsers).length - 1
                });
                
                delete connectedUsers[socketId];
            }
        });
    },

    cleanupOldMessages: () => {
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        const initialLength = messageHistory.length;
        
        messageHistory = messageHistory.filter(msg => 
            new Date(msg.timestamp).getTime() >= twentyFourHoursAgo
        );
        
        const removed = initialLength - messageHistory.length;
        if (removed > 0) {
            console.log(`🗑️ Limpiados ${removed} mensajes antiguos (24h+)`);
        }
    }
};

// ===== MANEJO DE SOCKET.IO =====
io.on('connection', (socket) => {
    console.log(`🔗 Nueva conexión: ${socket.id}`);
    
    socket.userData = {
        socketId: socket.id,
        userId: null,
        username: null,
        avatarColor: null,
        room: CONFIG.ROOM,
        joinedAt: Date.now(),
        lastActivity: Date.now()
    };

    socket.join(CONFIG.ROOM);

    // === UNIRSE AL CHAT ===
    socket.on('join', (data, callback) => {
        try {
            if (!data || !data.username) {
                throw new Error('Nombre de usuario requerido');
            }

            const username = data.username.trim();
            
            if (!utils.isValidUsername(username)) {
                throw new Error('Nombre inválido (2-20 caracteres alfanuméricos)');
            }

            const isNameTaken = Object.values(connectedUsers).some(
                user => user.username.toLowerCase() === username.toLowerCase() && 
                       user.socketId !== socket.id
            );

            if (isNameTaken) {
                throw new Error('Nombre ya en uso');
            }

            const userId = data.userId || `user_${utils.generateId()}`;
            const avatarColor = utils.generateAvatarColor(username);

            socket.userData = {
                ...socket.userData,
                userId,
                username,
                avatarColor,
                lastActivity: Date.now()
            };

            connectedUsers[socket.id] = { ...socket.userData };

            // 1. Enviar bienvenida
            socket.emit('welcome', {
                server: 'FoxWeb Chat v5.0',
                username,
                userId,
                avatarColor,
                timestamp: Date.now()
            });

            // 2. Enviar historial
            const recentMessages = messageHistory.slice(-CONFIG.MESSAGES_PER_PAGE);
            socket.emit('history', {
                messages: recentMessages,
                hasMore: messageHistory.length > CONFIG.MESSAGES_PER_PAGE,
                total: messageHistory.length
            });

            // 3. Notificar a otros usuarios
            socket.to(CONFIG.ROOM).emit('userJoined', {
                username,
                userId,
                avatarColor,
                onlineCount: Object.keys(connectedUsers).length
            });

            // 4. Actualizar lista de usuarios
            io.to(CONFIG.ROOM).emit('onlineUsers', {
                users: Object.values(connectedUsers).map(u => ({
                    userId: u.userId,
                    username: u.username,
                    avatarColor: u.avatarColor
                })),
                count: Object.keys(connectedUsers).length
            });

            // 5. Enviar contador
            io.to(CONFIG.ROOM).emit('userCount', Object.keys(connectedUsers).length);

            if (callback) {
                callback({
                    success: true,
                    username,
                    userId,
                    avatarColor
                });
            }

            console.log(`👋 ${username} se unió al chat`);

        } catch (error) {
            console.error('Error en join:', error.message);
            if (callback) {
                callback({
                    success: false,
                    error: error.message
                });
            }
        }
    });

    // === ENVIAR MENSAJE ===
    socket.on('message', (data, callback) => {
        try {
            if (!socket.userData.userId) {
                throw new Error('Debes unirte al chat primero');
            }

            if (!utils.isValidMessage(data?.text)) {
                throw new Error('Mensaje inválido');
            }

            const message = {
                id: `msg_${utils.generateId()}`,
                userId: socket.userData.userId,
                username: socket.userData.username,
                text: data.text,
                timestamp: new Date().toISOString(),
                time: utils.formatTime(new Date()),
                avatarColor: socket.userData.avatarColor,
                system: false
            };

            messageHistory.push(message);
            
            if (messageHistory.length > CONFIG.MAX_MESSAGES) {
                messageHistory = messageHistory.slice(-CONFIG.MAX_MESSAGES);
            }

            socket.userData.lastActivity = Date.now();
            connectedUsers[socket.id].lastActivity = Date.now();

            io.to(CONFIG.ROOM).emit('message', message);

            if (callback) {
                callback({ success: true, messageId: message.id });
            }

            console.log(`💬 ${socket.userData.username}: ${data.text.substring(0, 30)}...`);

        } catch (error) {
            console.error('Error en message:', error.message);
            if (callback) {
                callback({ success: false, error: error.message });
            }
        }
    });

    // === USUARIO ESCRIBIENDO ===
    socket.on('typing', () => {
        if (socket.userData.username) {
            typingUsers.add(socket.userData.username);
            socket.to(CONFIG.ROOM).emit('typing', {
                username: socket.userData.username,
                userId: socket.userData.userId
            });

            setTimeout(() => {
                typingUsers.delete(socket.userData.username);
                socket.to(CONFIG.ROOM).emit('stopTyping', {
                    username: socket.userData.username,
                    userId: socket.userData.userId
                });
            }, CONFIG.TYPING_TIMEOUT);
        }
    });

    // === DEJAR DE ESCRIBIR ===
    socket.on('stopTyping', () => {
        if (socket.userData.username) {
            typingUsers.delete(socket.userData.username);
            socket.to(CONFIG.ROOM).emit('stopTyping', {
                username: socket.userData.username,
                userId: socket.userData.userId
            });
        }
    });

    // === PING ===
    socket.on('ping', (data, callback) => {
        if (callback) {
            callback({
                success: true,
                serverTimestamp: Date.now(),
                clientTimestamp: data?.clientTimestamp || Date.now(),
                latency: Date.now() - (data?.clientTimestamp || Date.now())
            });
        }
    });

    // === DESCONEXIÓN ===
    socket.on('disconnect', (reason) => {
        const user = connectedUsers[socket.id];
        
        if (user) {
            delete connectedUsers[socket.id];
            typingUsers.delete(user.username);
            
            io.to(CONFIG.ROOM).emit('userLeft', {
                username: user.username,
                userId: user.userId,
                onlineCount: Object.keys(connectedUsers).length
            });
            
            io.to(CONFIG.ROOM).emit('onlineUsers', {
                users: Object.values(connectedUsers).map(u => ({
                    userId: u.userId,
                    username: u.username,
                    avatarColor: u.avatarColor
                })),
                count: Object.keys(connectedUsers).length
            });
            
            io.to(CONFIG.ROOM).emit('userCount', Object.keys(connectedUsers).length);
            
            console.log(`👋 ${user.username} se desconectó (${reason})`);
        }
    });

    socket.on('error', (error) => {
        console.error(`Socket error [${socket.id}]:`, error.message);
    });
});

// ===== MANTENIMIENTO PERIÓDICO =====
setInterval(() => {
    utils.cleanupInactiveUsers();
    utils.cleanupOldMessages();
    
    console.log('❤️ Heartbeat:', {
        onlineUsers: Object.keys(connectedUsers).length,
        messages: messageHistory.length,
        uptime: process.uptime()
    });
}, CONFIG.HEARTBEAT_INTERVAL);

// ===== INICIAR SERVIDOR =====
server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════╗
║     FOXWEB CHAT BACKEND v5.0         ║
╠══════════════════════════════════════╣
║ 📡 Puerto: ${CONFIG.PORT.toString().padEnd(26)} ║
║ 🌍 Frontend: ${CONFIG.CORS_ORIGIN.padEnd(23)} ║
║ 👥 Sala: ${CONFIG.ROOM.padEnd(28)} ║
║ 💾 Mensajes máx: ${CONFIG.MAX_MESSAGES.toString().padEnd(20)} ║
╚══════════════════════════════════════╝
`);
    console.log(`🚀 Backend iniciado en puerto ${CONFIG.PORT}`);
    console.log(`📡 WebSocket listo para conexiones desde: ${CONFIG.CORS_ORIGIN}`);
});

// ===== SHUTDOWN GRACIOSO =====
process.on('SIGINT', () => {
    console.log('\n🛑 Recibido SIGINT, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Recibido SIGTERM, cerrando servidor...');
    server.close(() => {
        console.log('✅ Servidor cerrado correctamente');
        process.exit(0);
    });
});