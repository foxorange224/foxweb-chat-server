// server.js - FoxWeb Chat Server v5.0 (Corregido para Render.com)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ===== CONFIGURACIÓN SEGURA =====
const PORT = process.env.PORT || 10000; // Render usa el puerto 10000
const NODE_ENV = process.env.NODE_ENV || 'production';
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const AUTO_PING_INTERVAL = 9 * 60 * 1000; // 9 minutos (menos de 10 para Render)
const MESSAGE_RETENTION_HOURS = 24;
const MAX_MESSAGES = 1000; // Reducido para evitar problemas de memoria
const MAX_MESSAGES_PER_USER = 200;
const RATE_LIMIT_WINDOW = 1000; // 1 segundo
const RATE_LIMIT_MAX = 3; // 3 mensajes por segundo
const MAX_USERNAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 2000;
const TYPING_TIMEOUT = 5000; // 5 segundos
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos
const INACTIVE_USER_TIMEOUT = 10 * 60 * 1000; // 10 minutos

// ===== MIDDLEWARE AVANZADO =====
app.use(helmet({
    contentSecurityPolicy: false // Desactivado temporalmente para desarrollo
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true
}));

// Rate limiting para API HTTP
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite por IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, por favor intenta más tarde' }
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Servir archivos estáticos desde 'public' si existe
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '1h' : '0'
}));

// ===== ALMACENAMIENTO EN MEMORIA SIMPLIFICADO =====
class ChatStorage {
    constructor() {
        this.users = new Map(); // socket.id -> {userId, username, socketId, joined, lastActivity}
        this.messages = []; // Mensajes del chat
        this.typingUsers = new Map(); // userId -> timestamp
        this.messageCounts = new Map(); // userId -> count
        this.connectionStats = {
            totalConnections: 0,
            totalMessages: 0,
            peakUsers: 0,
            startTime: Date.now()
        };
        
        console.log('💾 Almacenamiento inicializado');
    }

    addUser(socketId, userData) {
        const existingUser = this.getUserByUsername(userData.username);
        
        if (existingUser && existingUser.userId !== userData.userId) {
            userData.username = `${userData.username}_${Math.floor(Math.random() * 1000)}`;
        }
        
        const user = {
            socketId,
            userId: userData.userId || this.generateId('user'),
            username: this.sanitizeUsername(userData.username),
            joined: Date.now(),
            lastActivity: Date.now(),
            avatarColor: this.generateAvatarColor(userData.username),
            status: 'online'
        };
        
        this.users.set(socketId, user);
        this.connectionStats.totalConnections++;
        
        if (this.users.size > this.connectionStats.peakUsers) {
            this.connectionStats.peakUsers = this.users.size;
        }
        
        console.log(`👤 Usuario agregado: ${user.username} (ID: ${user.userId})`);
        return user;
    }

    removeUser(socketId) {
        const user = this.users.get(socketId);
        if (!user) return null;
        
        this.users.delete(socketId);
        this.typingUsers.delete(user.userId);
        
        console.log(`👤 Usuario removido: ${user.username} (Quedan: ${this.users.size})`);
        return user;
    }

    getUser(socketId) {
        return this.users.get(socketId);
    }

    getUserByUsername(username) {
        return Array.from(this.users.values()).find(u => 
            u.username.toLowerCase() === username.toLowerCase()
        );
    }

    updateUserActivity(socketId) {
        const user = this.users.get(socketId);
        if (user) {
            user.lastActivity = Date.now();
        }
    }

    canSendMessage(userId) {
        const now = Date.now();
        const userStats = this.messageCounts.get(userId) || { 
            count: 0, 
            windowStart: now,
            lastMessageTime: 0
        };
        
        if (now - userStats.windowStart >= RATE_LIMIT_WINDOW) {
            userStats.count = 0;
            userStats.windowStart = now;
        }
        
        if (userStats.count >= RATE_LIMIT_MAX) {
            const waitTime = RATE_LIMIT_WINDOW - (now - userStats.windowStart);
            return { 
                allowed: false, 
                waitTime: Math.ceil(waitTime / 1000)
            };
        }
        
        const minInterval = 500;
        if (now - userStats.lastMessageTime < minInterval) {
            return { 
                allowed: false, 
                waitTime: Math.ceil((minInterval - (now - userStats.lastMessageTime)) / 1000)
            };
        }
        
        userStats.count++;
        userStats.lastMessageTime = now;
        this.messageCounts.set(userId, userStats);
        
        return { allowed: true };
    }

    addMessage(message) {
        this.messages.push(message);
        
        if (this.messages.length > MAX_MESSAGES) {
            this.messages.shift();
        }
        
        this.connectionStats.totalMessages++;
        return message;
    }

    getHistory(limit = 100, offset = 0) {
        const start = Math.max(0, this.messages.length - limit - offset);
        const end = this.messages.length - offset;
        return this.messages.slice(start, end);
    }

    startTyping(userId) {
        this.typingUsers.set(userId, Date.now());
        return Array.from(this.typingUsers.keys());
    }

    stopTyping(userId) {
        this.typingUsers.delete(userId);
    }

    getTypingUsers() {
        const now = Date.now();
        const typing = [];
        
        for (const [userId, timestamp] of this.typingUsers) {
            if (now - timestamp < TYPING_TIMEOUT) {
                const user = Array.from(this.users.values()).find(u => u.userId === userId);
                if (user) {
                    typing.push({
                        userId: user.userId,
                        username: user.username
                    });
                }
            } else {
                this.typingUsers.delete(userId);
            }
        }
        
        return typing;
    }

    cleanOldMessages() {
        const cutoffTime = Date.now() - (MESSAGE_RETENTION_HOURS * 60 * 60 * 1000);
        const initialCount = this.messages.length;
        
        this.messages = this.messages.filter(msg => 
            new Date(msg.timestamp).getTime() >= cutoffTime
        );
        
        const cleaned = initialCount - this.messages.length;
        if (cleaned > 0) {
            console.log(`🧹 Limpiados ${cleaned} mensajes antiguos`);
        }
        
        return cleaned;
    }

    cleanInactiveUsers() {
        const cutoffTime = Date.now() - INACTIVE_USER_TIMEOUT;
        const inactiveUsers = [];
        
        for (const [socketId, user] of this.users) {
            if (user.lastActivity < cutoffTime) {
                inactiveUsers.push(socketId);
            }
        }
        
        inactiveUsers.forEach(socketId => {
            this.users.delete(socketId);
        });
        
        return inactiveUsers.length;
    }

    getStats() {
        const now = Date.now();
        const uptime = now - this.connectionStats.startTime;
        
        const seconds = Math.floor(uptime / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        let uptimeStr = '';
        if (days > 0) uptimeStr = `${days}d ${hours}h ${minutes}m`;
        else if (hours > 0) uptimeStr = `${hours}h ${minutes}m ${secs}s`;
        else if (minutes > 0) uptimeStr = `${minutes}m ${secs}s`;
        else uptimeStr = `${secs}s`;
        
        return {
            users: {
                total: this.users.size,
                typing: this.getTypingUsers().length
            },
            messages: {
                total: this.connectionStats.totalMessages,
                stored: this.messages.length
            },
            performance: {
                uptime: uptimeStr,
                peakUsers: this.connectionStats.peakUsers,
                totalConnections: this.connectionStats.totalConnections
            }
        };
    }

    generateId(prefix) {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    sanitizeUsername(username) {
        if (!username || typeof username !== 'string') {
            return `Usuario${Math.floor(Math.random() * 10000)}`;
        }
        
        let sanitized = username.trim();
        if (sanitized.length > MAX_USERNAME_LENGTH) {
            sanitized = sanitized.substring(0, MAX_USERNAME_LENGTH);
        }
        
        sanitized = sanitized.replace(/[<>'"&]/g, '');
        
        if (!sanitized) {
            sanitized = `Usuario${Math.floor(Math.random() * 10000)}`;
        }
        
        return sanitized;
    }

    generateAvatarColor(username) {
        const colors = [
            '#FF6B6B', '#4ECDC4', '#FFD166', '#06D6A0', '#118AB2',
            '#073B4C', '#EF476F', '#FFD166', '#06D6A0', '#118AB2',
            '#7209B7', '#F72585', '#3A0CA3', '#4361EE', '#4CC9F0'
        ];
        
        let hash = 0;
        for (let i = 0; i < username.length; i++) {
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        return colors[Math.abs(hash) % colors.length];
    }
}

// ===== INICIALIZACIÓN DEL SERVIDOR =====
const storage = new ChatStorage();

// Configuración de Socket.io optimizada para Render
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6,
    connectTimeout: 45000,
    allowEIO3: true,
    path: '/socket.io/' // Importante para Render
});

// ===== AUTO-PING SIMPLIFICADO =====
let autoPingInterval;
let cleanupInterval;

function startAutoPing() {
    console.log(`🔄 Configurando auto-ping cada ${AUTO_PING_INTERVAL / 60000} minutos...`);
    
    autoPingInterval = setInterval(() => {
        console.log(`🔄 Auto-ping: ${storage.users.size} usuarios conectados, ${storage.messages.length} mensajes`);
    }, AUTO_PING_INTERVAL);
}

function startCleanupSchedule() {
    console.log('🧹 Iniciando limpieza programada...');
    
    cleanupInterval = setInterval(() => {
        try {
            const cleanedMessages = storage.cleanOldMessages();
            const cleanedUsers = storage.cleanInactiveUsers();
            
            if (cleanedMessages > 0 || cleanedUsers > 0) {
                console.log(`🧹 Mantenimiento: ${cleanedMessages} mensajes, ${cleanedUsers} usuarios`);
            }
            
        } catch (error) {
            console.error('Error en limpieza programada:', error);
        }
    }, CLEANUP_INTERVAL);
}

// ===== MANEJO DE CONEXIONES SOCKET.IO =====
io.on('connection', (socket) => {
    console.log(`🔗 Nueva conexión: ${socket.id}`);
    
    socket.emit('welcome', {
        server: 'FoxWeb Chat v5.0',
        timestamp: new Date().toISOString(),
        message: 'Conectado al servidor. Ingresa tu nombre de usuario.'
    });

    socket.on('join', (userData, callback) => {
        try {
            if (!userData || typeof userData !== 'object') {
                socket.emit('error', { message: 'Datos de usuario inválidos' });
                return;
            }
            
            const username = userData.username?.trim();
            const userId = userData.userId || storage.generateId('user');
            
            if (!username || username.length < 2) {
                socket.emit('error', { message: 'El nombre debe tener al menos 2 caracteres' });
                return;
            }
            
            if (username.length > MAX_USERNAME_LENGTH) {
                socket.emit('error', { message: `El nombre no puede exceder ${MAX_USERNAME_LENGTH} caracteres` });
                return;
            }
            
            const user = storage.addUser(socket.id, { username, userId });
            
            socket.join('general');
            
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    userId: user.userId,
                    username: user.username,
                    avatarColor: user.avatarColor,
                    onlineCount: storage.users.size
                });
            }
            
            socket.broadcast.emit('userJoined', {
                userId: user.userId,
                username: user.username,
                timestamp: new Date().toISOString(),
                onlineCount: storage.users.size
            });
            
            const history = storage.getHistory(100);
            socket.emit('history', {
                messages: history,
                total: storage.messages.length,
                hasMore: storage.messages.length > 100
            });
            
            const onlineUsers = Array.from(storage.users.values()).map(u => ({
                userId: u.userId,
                username: u.username,
                avatarColor: u.avatarColor,
                status: u.status
            }));
            
            io.emit('onlineUsers', {
                users: onlineUsers,
                count: onlineUsers.length
            });
            
            console.log(`👋 ${user.username} se unió al chat. Total: ${storage.users.size}`);
            
        } catch (error) {
            console.error('Error en evento join:', error);
            socket.emit('error', { message: 'Error interno del servidor' });
        }
    });

    socket.on('message', (messageData, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) {
                socket.emit('error', { message: 'Debes unirte al chat primero' });
                return;
            }
            
            const text = messageData.text?.trim();
            if (!text) {
                socket.emit('error', { message: 'El mensaje no puede estar vacío' });
                return;
            }
            
            if (text.length > MAX_MESSAGE_LENGTH) {
                socket.emit('error', { message: `El mensaje no puede exceder ${MAX_MESSAGE_LENGTH} caracteres` });
                return;
            }
            
            const rateCheck = storage.canSendMessage(user.userId);
            if (!rateCheck.allowed) {
                socket.emit('error', { 
                    message: `Espera ${rateCheck.waitTime} segundos antes de enviar otro mensaje`
                });
                return;
            }
            
            const message = {
                id: storage.generateId('msg'),
                userId: user.userId,
                username: user.username,
                text: text,
                timestamp: new Date().toISOString(),
                time: new Date().toLocaleTimeString('es-ES', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    second: '2-digit'
                }),
                avatarColor: user.avatarColor,
                system: false
            };
            
            const savedMessage = storage.addMessage(message);
            storage.updateUserActivity(socket.id);
            
            storage.stopTyping(user.userId);
            socket.broadcast.emit('stopTyping', {
                userId: user.userId,
                username: user.username
            });
            
            io.emit('message', savedMessage);
            
            if (typeof callback === 'function') {
                callback({ 
                    success: true, 
                    messageId: savedMessage.id,
                    timestamp: savedMessage.timestamp
                });
            }
            
            console.log(`💬 ${user.username}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);
            
        } catch (error) {
            console.error('Error en evento message:', error);
            socket.emit('error', { message: 'Error al enviar mensaje' });
        }
    });

    socket.on('typing', () => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) return;
            
            storage.updateUserActivity(socket.id);
            storage.startTyping(user.userId);
            
            socket.broadcast.emit('typing', {
                userId: user.userId,
                username: user.username
            });
            
        } catch (error) {
            console.error('Error en evento typing:', error);
        }
    });

    socket.on('stopTyping', () => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) return;
            
            storage.stopTyping(user.userId);
            
            socket.broadcast.emit('stopTyping', {
                userId: user.userId,
                username: user.username
            });
            
        } catch (error) {
            console.error('Error en evento stopTyping:', error);
        }
    });

    socket.on('changeUsername', (data, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) {
                socket.emit('error', { message: 'Usuario no autenticado' });
                return;
            }
            
            const newUsername = data.newUsername?.trim();
            if (!newUsername || newUsername.length < 2) {
                socket.emit('error', { message: 'Nombre inválido' });
                return;
            }
            
            if (newUsername.length > MAX_USERNAME_LENGTH) {
                socket.emit('error', { message: `Nombre demasiado largo (máx. ${MAX_USERNAME_LENGTH} caracteres)` });
                return;
            }
            
            const existingUser = storage.getUserByUsername(newUsername);
            if (existingUser && existingUser.userId !== user.userId) {
                socket.emit('error', { message: 'El nombre ya está en uso' });
                return;
            }
            
            const oldUsername = user.username;
            user.username = newUsername;
            user.avatarColor = storage.generateAvatarColor(newUsername);
            
            io.emit('usernameChanged', {
                userId: user.userId,
                oldUsername: oldUsername,
                newUsername: newUsername,
                timestamp: new Date().toISOString(),
                avatarColor: user.avatarColor
            });
            
            const onlineUsers = Array.from(storage.users.values()).map(u => ({
                userId: u.userId,
                username: u.username,
                avatarColor: u.avatarColor,
                status: u.status
            }));
            
            io.emit('onlineUsers', {
                users: onlineUsers,
                count: onlineUsers.length
            });
            
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    newUsername: newUsername,
                    avatarColor: user.avatarColor
                });
            }
            
            console.log(`📝 ${oldUsername} cambió a ${newUsername}`);
            
        } catch (error) {
            console.error('Error en evento changeUsername:', error);
            socket.emit('error', { message: 'Error al cambiar nombre' });
        }
    });

    socket.on('ping', (data, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (user) {
                storage.updateUserActivity(socket.id);
            }
            
            const response = {
                serverTime: new Date().toISOString(),
                timestamp: Date.now(),
                uptime: process.uptime()
            };
            
            if (typeof callback === 'function') {
                callback(response);
            } else {
                socket.emit('pong', response);
            }
            
        } catch (error) {
            console.error('Error en evento ping:', error);
        }
    });

    socket.on('loadMoreMessages', (data, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) return;
            
            const offset = data.offset || 0;
            const limit = Math.min(data.limit || 50, 100);
            
            const messages = storage.getHistory(limit, offset);
            const hasMore = storage.messages.length > offset + limit;
            
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    messages: messages,
                    hasMore: hasMore,
                    offset: offset,
                    total: storage.messages.length
                });
            }
            
        } catch (error) {
            console.error('Error en evento loadMoreMessages:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: 'Error al cargar mensajes'
                });
            }
        }
    });

    socket.on('getOnlineUsers', (callback) => {
        try {
            const onlineUsers = Array.from(storage.users.values()).map(u => ({
                userId: u.userId,
                username: u.username,
                avatarColor: u.avatarColor,
                status: u.status
            }));
            
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    users: onlineUsers,
                    count: onlineUsers.length,
                    timestamp: new Date().toISOString()
                });
            }
            
        } catch (error) {
            console.error('Error en evento getOnlineUsers:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: 'Error al obtener usuarios'
                });
            }
        }
    });

    socket.on('getStats', (callback) => {
        try {
            const stats = storage.getStats();
            
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    stats: stats,
                    timestamp: new Date().toISOString()
                });
            }
            
        } catch (error) {
            console.error('Error en evento getStats:', error);
            if (typeof callback === 'function') {
                callback({
                    success: false,
                    error: 'Error al obtener estadísticas'
                });
            }
        }
    });

    socket.on('disconnect', (reason) => {
        try {
            const user = storage.removeUser(socket.id);
            
            if (user) {
                socket.broadcast.emit('userLeft', {
                    userId: user.userId,
                    username: user.username,
                    timestamp: new Date().toISOString(),
                    onlineCount: storage.users.size,
                    reason: reason
                });
                
                io.emit('userCount', storage.users.size);
                
                console.log(`👋 ${user.username} desconectado (${reason}). Quedan: ${storage.users.size}`);
            }
            
        } catch (error) {
            console.error('Error en evento disconnect:', error);
        }
    });

    socket.on('error', (error) => {
        console.error(`Socket error ${socket.id}:`, error);
    });
});

// ===== RUTAS HTTP/API =====

// Health check para Render
app.get('/health', (req, res) => {
    const stats = storage.getStats();
    
    res.status(200).json({
        status: 'healthy',
        server: 'FoxWeb Chat v5.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        stats: {
            users: stats.users.total,
            messages: stats.messages.stored,
            uptime: stats.performance.uptime
        }
    });
});

// Ruta principal
app.get('/', (req, res) => {
    res.json({
        server: 'FoxWeb Chat Server v5.0',
        status: 'online',
        version: '5.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        endpoints: {
            health: '/health',
            status: '/status',
            stats: '/stats',
            socketio: '/socket.io/'
        },
        message: 'Socket.IO server is running'
    });
});

// Ruta de estado del servidor
app.get('/status', apiLimiter, (req, res) => {
    const stats = storage.getStats();
    
    res.json({
        status: 'online',
        server: 'FoxWeb Chat Server v5.0',
        version: '5.0.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: NODE_ENV,
        ...stats,
        features: [
            'Chat en tiempo real con Socket.io',
            'Historial de 24 horas con paginación',
            'Indicador de escritura en tiempo real',
            'Cambio de nombre dinámico',
            'Soporte para emojis'
        ]
    });
});

// API: Obtener estadísticas detalladas
app.get('/stats', apiLimiter, (req, res) => {
    try {
        const stats = storage.getStats();
        
        res.json({
            success: true,
            ...stats,
            socketio: {
                connectedSockets: io.engine.clientsCount
            },
            process: {
                pid: process.pid,
                memory: process.memoryUsage(),
                uptime: process.uptime(),
                version: process.version
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Obtener mensajes recientes
app.get('/api/messages', apiLimiter, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        
        const messages = storage.getHistory(limit, offset);
        
        res.json({
            success: true,
            count: messages.length,
            total: storage.messages.length,
            offset: offset,
            limit: limit,
            hasMore: storage.messages.length > offset + limit,
            messages: messages.map(msg => ({
                id: msg.id,
                username: msg.username,
                text: msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : ''),
                timestamp: msg.timestamp,
                avatarColor: msg.avatarColor
            }))
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Obtener usuarios en línea
app.get('/api/users', apiLimiter, (req, res) => {
    try {
        const onlineUsers = Array.from(storage.users.values()).map(u => ({
            userId: u.userId,
            username: u.username,
            joined: u.joined,
            lastActivity: u.lastActivity,
            status: u.status,
            avatarColor: u.avatarColor
        }));
        
        res.json({
            success: true,
            count: onlineUsers.length,
            users: onlineUsers,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Ruta no encontrada',
        available: [
            '/',
            '/health',
            '/status',
            '/stats',
            '/api/messages',
            '/api/users'
        ]
    });
});

// ===== INICIAR SERVIDOR =====
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🚀 FOXWEB CHAT SERVER v5.0
    ============================
    📡 Puerto: ${PORT}
    🌐 URL: ${RENDER_URL}
    📊 Entorno: ${NODE_ENV}
    💾 Almacenamiento: ${MAX_MESSAGES.toLocaleString()} mensajes máx.
    ⏳ Retención: ${MESSAGE_RETENTION_HOURS} horas
    ⚡ Rate Limit: ${RATE_LIMIT_MAX} mensajes/${RATE_LIMIT_WINDOW}ms
    🔄 Auto-ping: Cada ${AUTO_PING_INTERVAL / 60000} minutos
    
    ✅ Servidor iniciado correctamente
    `);
    
    // Iniciar servicios de mantenimiento
    setTimeout(() => {
        startAutoPing();
        startCleanupSchedule();
        
        // Limpieza inicial
        storage.cleanOldMessages();
        console.log('🧹 Limpieza inicial completada');
        
    }, 3000);
});

// ===== MANEJO DE SEÑALES PARA SHUTDOWN GRACEFUL =====
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown() {
    console.log('\n🛑 Recibida señal de terminación, iniciando shutdown graceful...');
    
    // Detener servicios
    if (autoPingInterval) clearInterval(autoPingInterval);
    if (cleanupInterval) clearInterval(cleanupInterval);
    
    // Desconectar todos los sockets
    io.disconnectSockets(true);
    console.log(`🔌 Desconectados ${storage.users.size} usuarios`);
    
    // Cerrar servidor HTTP
    server.close(() => {
        console.log('✅ Servidor HTTP cerrado');
        console.log('👋 Shutdown graceful completado');
        process.exit(0);
    });
    
    // Timeout forzoso después de 15 segundos
    setTimeout(() => {
        console.log('⚠️  Forzando cierre después de timeout');
        process.exit(1);
    }, 15000);
}

// ===== MANEJO DE ERRORES =====
process.on('uncaughtException', (error) => {
    console.error('❌ ERROR NO CAPTURADO:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ PROMESA RECHAZADA NO MANEJADA:', reason);
});