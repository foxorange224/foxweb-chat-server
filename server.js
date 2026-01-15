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
    HEARTBEAT_INTERVAL: 30000,    // REDUCIDO a 30s para mejor keep-alive
    PING_INTERVAL: 25000,
    ROOM: 'general',
    CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
    RATE_LIMIT: {
        windowMs: 60 * 1000,
        max: 100
    }
};

// ===== DEPENDENCIAS =====
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// ===== INICIALIZACIÓN =====
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: CONFIG.CORS_ORIGIN,
        methods: ['GET', 'POST'],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutos
        skipMiddlewares: true
    }
});

// ===== MIDDLEWARE =====
app.use(helmet({
    contentSecurityPolicy: false // Desactivado temporalmente para facilitar
}));

app.use(cors({
    origin: CONFIG.CORS_ORIGIN,
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: CONFIG.RATE_LIMIT.windowMs,
    max: CONFIG.RATE_LIMIT.max,
    message: 'Demasiadas peticiones, por favor intenta más tarde',
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', apiLimiter);

// Servir archivos estáticos
app.use(express.static(__dirname));

// ===== ENDPOINTS CRÍTICOS =====

// 1. Endpoint PRINCIPAL para mantener activo (IMPORTANTE PARA RENDER)
app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'active',
        uptime: process.uptime(),
                         timestamp: Date.now(),
                         onlineUsers: Object.keys(connectedUsers).length,
                         messages: messageHistory.length,
                         server: 'FoxWeb Chat v5.0'
    });
});

// 2. Endpoint de health check para servicios de monitoreo
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// 3. Endpoint de estado detallado
app.get('/api/status', (req, res) => {
    const memoryUsage = process.memoryUsage();
    res.json({
        server: 'FoxWeb Chat',
        version: '5.0',
        status: 'online',
        uptime: Math.floor(process.uptime()),
             timestamp: Date.now(),
             onlineUsers: Object.keys(connectedUsers).length,
             totalMessages: messageHistory.length,
             memory: {
                 heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
             heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`,
             rss: `${Math.round(memoryUsage.rss / 1024 / 1024)}MB`
             },
             node: process.version
    });
});

// 4. Servir la aplicación
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'https://foxweb.pages.dev/chat'));
});

// ===== ESTADO DEL SERVIDOR =====
const connectedUsers = {};           // Usuarios conectados
let messageHistory = [];             // Historial de mensajes (usar LET, no CONST)
const typingUsers = new Set();       // Usuarios escribiendo
let serverStartTime = Date.now();    // Tiempo de inicio

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

    // CORREGIDO: Función de limpieza
    cleanupInactiveUsers: () => {
        const now = Date.now();
        const inactiveThreshold = 2 * 60 * 1000; // 2 minutos

        Object.keys(connectedUsers).forEach(socketId => {
            const user = connectedUsers[socketId];
            if (now - (user.lastActivity || 0) > inactiveThreshold) {
                console.log(`🕒 Usuario inactivo removido: ${user.username}`);

                // Remover de typingUsers
                typingUsers.delete(user.username);

                // Notificar desconexión
                io.to(CONFIG.ROOM).emit('userLeft', {
                    username: user.username,
                    userId: user.userId,
                    onlineCount: Object.keys(connectedUsers).length - 1
                });

                // Eliminar del tracking
                delete connectedUsers[socketId];
            }
        });
    },

    // CORREGIDO: Limpiar mensajes antiguos
    cleanupOldMessages: () => {
        const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
        const initialLength = messageHistory.length;

        // Filtrar mensajes recientes
        messageHistory = messageHistory.filter(msg =>
        new Date(msg.timestamp).getTime() >= twentyFourHoursAgo
        );

        const removed = initialLength - messageHistory.length;
        if (removed > 0) {
            console.log(`🗑️ Limpiados ${removed} mensajes antiguos (24h+)`);
        }
    },

    getServerStats: () => {
        const memory = process.memoryUsage();
        return {
            uptime: Math.floor(process.uptime()),
            memory: `${Math.round(memory.heapUsed / 1024 / 1024)}MB`,
            users: Object.keys(connectedUsers).length,
            messages: messageHistory.length,
            typing: typingUsers.size
        };
    }
};

// ===== MANEJO DE SOCKET.IO =====
io.on('connection', (socket) => {
    console.log(`🔗 Nueva conexión: ${socket.id}`);

    // Estado inicial del usuario
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

            // Validar nombre
            if (!utils.isValidUsername(username)) {
                throw new Error('Nombre inválido (2-20 caracteres alfanuméricos)');
            }

            // Verificar nombre único
            const isNameTaken = Object.values(connectedUsers).some(
                user => user.username.toLowerCase() === username.toLowerCase() &&
                user.socketId !== socket.id
            );

            if (isNameTaken) {
                throw new Error('Nombre ya en uso');
            }

            // Crear usuario
            const userId = data.userId || `user_${utils.generateId()}`;
            const avatarColor = utils.generateAvatarColor(username);

            socket.userData = {
                ...socket.userData,
                userId,
                username,
                avatarColor,
                lastActivity: Date.now()
            };

            // Guardar en usuarios conectados
            connectedUsers[socket.id] = { ...socket.userData };

            // 1. Enviar bienvenida al usuario
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

            // 4. Actualizar lista de usuarios para todos
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

            // Callback de éxito
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

            // Agregar al historial
            messageHistory.push(message);

            // Limitar historial
            if (messageHistory.length > CONFIG.MAX_MESSAGES) {
                messageHistory = messageHistory.slice(-CONFIG.MAX_MESSAGES);
            }

            // Actualizar actividad
            socket.userData.lastActivity = Date.now();
            connectedUsers[socket.id].lastActivity = Date.now();

            // Enviar a todos
            io.to(CONFIG.ROOM).emit('message', message);

            // Callback
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

            // Auto-remover después de timeout
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
            // Remover de usuarios conectados
            delete connectedUsers[socket.id];

            // Remover de typingUsers
            typingUsers.delete(user.username);

            // Notificar a otros usuarios
            io.to(CONFIG.ROOM).emit('userLeft', {
                username: user.username,
                userId: user.userId,
                onlineCount: Object.keys(connectedUsers).length
            });

            // Actualizar lista de usuarios
            io.to(CONFIG.ROOM).emit('onlineUsers', {
                users: Object.values(connectedUsers).map(u => ({
                    userId: u.userId,
                    username: u.username,
                    avatarColor: u.avatarColor
                })),
                count: Object.keys(connectedUsers).length
            });

            // Actualizar contador
            io.to(CONFIG.ROOM).emit('userCount', Object.keys(connectedUsers).length);

            console.log(`👋 ${user.username} se desconectó (${reason})`);
        }
    });

    // === ERRORES ===
    socket.on('error', (error) => {
        console.error(`Socket error [${socket.id}]:`, error.message);
    });
});

// ===== SISTEMA DE MANTENIMIENTO =====
setInterval(() => {
    // Limpieza periódica
    utils.cleanupInactiveUsers();
    utils.cleanupOldMessages();

    // Log de estado
    const stats = utils.getServerStats();
    console.log('❤️ Heartbeat:', stats);

}, CONFIG.HEARTBEAT_INTERVAL);

// ===== INICIAR SERVIDOR =====
server.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════╗
    ║        FOXWEB CHAT SERVER v5.0       ║
    ╠══════════════════════════════════════╣
    ║ 📡 Puerto: ${CONFIG.PORT.toString().padEnd(26)} ║
    ║ 🌍 Entorno: ${CONFIG.NODE_ENV.padEnd(25)} ║
    ║ 👥 Sala: ${CONFIG.ROOM.padEnd(28)} ║
    ║ 💾 Mensajes máx: ${CONFIG.MAX_MESSAGES.toString().padEnd(20)} ║
    ║ ❤️ Heartbeat: ${CONFIG.HEARTBEAT_INTERVAL/1000}s${' '.repeat(20)} ║
    ╚══════════════════════════════════════╝
    `);
    console.log(`🚀 Servidor iniciado: http://localhost:${CONFIG.PORT}`);
    console.log(`📊 Endpoint de salud: http://localhost:${CONFIG.PORT}/ping`);
    console.log(`👁️  Monitor: http://localhost:${CONFIG.PORT}/api/status`);
});

// ===== MANEJO DE SHUTDOWN =====
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

function gracefulShutdown(signal) {
    console.log(`\n🛑 Recibido ${signal}, cerrando servidor...`);

    // Notificar a los usuarios
    io.emit('systemMessage', {
        type: 'warning',
        text: 'El servidor se reiniciará. Reconectando en breve...',
        timestamp: new Date().toISOString()
    });

    setTimeout(() => {
        server.close(() => {
            console.log('✅ Servidor cerrado correctamente');
            process.exit(0);
        });
    }, 2000);
}
