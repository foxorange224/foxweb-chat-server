// server.js - FoxWeb Chat Server v5.0 (Completo y Robustecido)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ===== CONFIGURACIÓN SEGURA =====
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const AUTO_PING_INTERVAL = 9 * 60 * 1000; // 9 minutos (menos de 10 para Render)
const MESSAGE_RETENTION_HOURS = 24;
const MAX_MESSAGES = 5000;
const MAX_MESSAGES_PER_USER = 1000;
const RATE_LIMIT_WINDOW = 1000; // 1 segundo
const RATE_LIMIT_MAX = 2; // 2 mensajes por segundo
const MAX_USERNAME_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 2000;
const TYPING_TIMEOUT = 5000; // 5 segundos
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos
const INACTIVE_USER_TIMEOUT = 10 * 60 * 1000; // 10 minutos

// ===== MIDDLEWARE AVANZADO =====
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
            imgSrc: ["'self'", "data:", "https://i.imgur.com", "https://*"],
            connectSrc: ["'self'", "wss:", "ws:", "https://cdn.socket.io"]
        }
    }
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
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
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '1h' : '0',
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    }
}));

// ===== ALMACENAMIENTO EN MEMORIA OPTIMIZADO =====
class ChatStorage {
    constructor() {
        this.users = new Map(); // socket.id -> {userId, username, socketId, joined, lastActivity, ip}
        this.userSockets = new Map(); // userId -> [socketIds] (para múltiples conexiones)
        this.messages = []; // Mensajes del chat con metadata completa
        this.typingUsers = new Map(); // userId -> {username, startTime}
        this.messageCounts = new Map(); // userId -> {count, windowStart}
        this.userIps = new Map(); // userId -> último IP
        this.connectionStats = {
            totalConnections: 0,
            totalMessages: 0,
            peakUsers: 0,
            startTime: Date.now()
        };
        
        // Índices para búsqueda rápida
        this.messageIndex = new Map(); // messageId -> índice
        this.userMessages = new Map(); // userId -> [messageIds]
        
        console.log('💾 Almacenamiento inicializado');
    }

    // ===== GESTIÓN DE USUARIOS =====
    addUser(socketId, userData, ip = '') {
        const existingUser = this.getUserByUsername(userData.username);
        
        // Si el usuario ya existe con diferente socket, manejar múltiples conexiones
        if (existingUser && existingUser.userId !== userData.userId) {
            // Usuario con mismo nombre pero diferente ID - agregar sufijo
            userData.username = `${userData.username}_${Math.floor(Math.random() * 1000)}`;
        }
        
        const user = {
            socketId,
            userId: userData.userId || this.generateId('user'),
            username: this.sanitizeUsername(userData.username),
            joined: Date.now(),
            lastActivity: Date.now(),
            ip: ip,
            avatarColor: this.generateAvatarColor(userData.username),
            status: 'online'
        };
        
        // Almacenar usuario principal
        this.users.set(socketId, user);
        
        // Mapear userId a socketIds (soporte para múltiples pestañas)
        if (!this.userSockets.has(user.userId)) {
            this.userSockets.set(user.userId, new Set());
        }
        this.userSockets.get(user.userId).add(socketId);
        
        // Mapear IP
        this.userIps.set(user.userId, ip);
        
        // Actualizar estadísticas
        this.connectionStats.totalConnections++;
        const currentUsers = this.users.size;
        if (currentUsers > this.connectionStats.peakUsers) {
            this.connectionStats.peakUsers = currentUsers;
        }
        
        console.log(`👤 Usuario agregado: ${user.username} (ID: ${user.userId})`);
        return user;
    }

    removeUser(socketId) {
        const user = this.users.get(socketId);
        if (!user) return null;
        
        // Eliminar socket de la lista de sockets del usuario
        const userSockets = this.userSockets.get(user.userId);
        if (userSockets) {
            userSockets.delete(socketId);
            
            // Si no quedan sockets para este usuario, eliminarlo completamente
            if (userSockets.size === 0) {
                this.userSockets.delete(user.userId);
                this.userIps.delete(user.userId);
                this.messageCounts.delete(user.userId);
                this.typingUsers.delete(user.userId);
            }
        }
        
        // Eliminar usuario principal
        this.users.delete(socketId);
        
        // Actualizar estadísticas
        const currentUsers = this.users.size;
        
        console.log(`👤 Usuario removido: ${user.username} (Quedan: ${currentUsers})`);
        return user;
    }

    getUser(socketId) {
        return this.users.get(socketId);
    }

    getUserByUserId(userId) {
        const sockets = this.userSockets.get(userId);
        if (!sockets || sockets.size === 0) return null;
        
        // Obtener el primer socket del usuario
        const firstSocket = sockets.values().next().value;
        return this.users.get(firstSocket);
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
            user.status = 'online';
        }
    }

    // ===== GESTIÓN DE MENSAJES CON RATE LIMITING =====
    canSendMessage(userId) {
        const now = Date.now();
        const userStats = this.messageCounts.get(userId) || { 
            count: 0, 
            windowStart: now,
            lastMessageTime: 0
        };
        
        // Resetear contador si la ventana ha expirado
        if (now - userStats.windowStart >= RATE_LIMIT_WINDOW) {
            userStats.count = 0;
            userStats.windowStart = now;
        }
        
        // Verificar límite de tasa
        if (userStats.count >= RATE_LIMIT_MAX) {
            const waitTime = RATE_LIMIT_WINDOW - (now - userStats.windowStart);
            return { 
                allowed: false, 
                waitTime: Math.ceil(waitTime / 1000),
                reason: 'rate_limit'
            };
        }
        
        // Verificar intervalo mínimo entre mensajes (300ms)
        const minInterval = 300;
        if (now - userStats.lastMessageTime < minInterval) {
            return { 
                allowed: false, 
                waitTime: Math.ceil((minInterval - (now - userStats.lastMessageTime)) / 1000),
                reason: 'too_fast'
            };
        }
        
        userStats.count++;
        userStats.lastMessageTime = now;
        this.messageCounts.set(userId, userStats);
        
        return { allowed: true };
    }

    addMessage(message) {
        // Validar que no haya mensajes duplicados
        if (this.messageIndex.has(message.id)) {
            console.warn(`⚠️ Intento de agregar mensaje duplicado: ${message.id}`);
            return null;
        }
        
        // Agregar mensaje
        this.messages.push(message);
        const messageIndex = this.messages.length - 1;
        
        // Actualizar índices
        this.messageIndex.set(message.id, messageIndex);
        
        // Mapear mensajes por usuario
        if (!this.userMessages.has(message.userId)) {
            this.userMessages.set(message.userId, []);
        }
        this.userMessages.get(message.userId).push(message.id);
        
        // Limitar tamaño total de mensajes
        if (this.messages.length > MAX_MESSAGES) {
            this.removeOldMessages(this.messages.length - MAX_MESSAGES);
        }
        
        // Limitar mensajes por usuario
        const userMsgIds = this.userMessages.get(message.userId);
        if (userMsgIds && userMsgIds.length > MAX_MESSAGES_PER_USER) {
            const toRemove = userMsgIds.length - MAX_MESSAGES_PER_USER;
            for (let i = 0; i < toRemove; i++) {
                const oldMsgId = userMsgIds[i];
                this.removeMessage(oldMsgId);
            }
        }
        
        this.connectionStats.totalMessages++;
        return message;
    }

    getMessage(messageId) {
        const index = this.messageIndex.get(messageId);
        return index !== undefined ? this.messages[index] : null;
    }

    getHistory(limit = 100, offset = 0) {
        const start = Math.max(0, this.messages.length - limit - offset);
        const end = this.messages.length - offset;
        return this.messages.slice(start, end);
    }

    getMessagesByUser(userId, limit = 50) {
        const msgIds = this.userMessages.get(userId) || [];
        const messages = [];
        
        for (let i = Math.max(0, msgIds.length - limit); i < msgIds.length; i++) {
            const msg = this.getMessage(msgIds[i]);
            if (msg) messages.push(msg);
        }
        
        return messages;
    }

    removeMessage(messageId) {
        const index = this.messageIndex.get(messageId);
        if (index === undefined) return false;
        
        // Eliminar de arrays
        const message = this.messages[index];
        this.messages.splice(index, 1);
        this.messageIndex.delete(messageId);
        
        // Actualizar índices de mensajes posteriores
        for (let i = index; i < this.messages.length; i++) {
            this.messageIndex.set(this.messages[i].id, i);
        }
        
        // Eliminar de índice de usuario
        const userMsgIds = this.userMessages.get(message.userId);
        if (userMsgIds) {
            const userIndex = userMsgIds.indexOf(messageId);
            if (userIndex > -1) {
                userMsgIds.splice(userIndex, 1);
            }
        }
        
        return true;
    }

    removeOldMessages(count) {
        const removed = [];
        for (let i = 0; i < count && this.messages.length > 0; i++) {
            const message = this.messages.shift();
            if (message) {
                this.messageIndex.delete(message.id);
                
                const userMsgIds = this.userMessages.get(message.userId);
                if (userMsgIds) {
                    const index = userMsgIds.indexOf(message.id);
                    if (index > -1) userMsgIds.splice(index, 1);
                }
                
                removed.push(message);
            }
        }
        return removed;
    }

    // ===== GESTIÓN DE TYPING =====
    startTyping(userId) {
        const user = this.getUserByUserId(userId);
        if (!user) return [];
        
        this.typingUsers.set(userId, {
            username: user.username,
            startTime: Date.now(),
            userId: userId
        });
        
        return this.getTypingUsers();
    }

    stopTyping(userId) {
        this.typingUsers.delete(userId);
    }

    getTypingUsers() {
        const now = Date.now();
        const expired = [];
        
        // Limpiar usuarios que llevan más del timeout escribiendo
        for (const [userId, data] of this.typingUsers) {
            if (now - data.startTime > TYPING_TIMEOUT) {
                expired.push(userId);
            }
        }
        
        expired.forEach(userId => this.typingUsers.delete(userId));
        
        return Array.from(this.typingUsers.values()).map(data => ({
            username: data.username,
            userId: data.userId,
            typingFor: Math.floor((now - data.startTime) / 1000)
        }));
    }

    // ===== LIMPIEZA Y MANTENIMIENTO =====
    cleanOldMessages(retentionHours = MESSAGE_RETENTION_HOURS) {
        const cutoffTime = Date.now() - (retentionHours * 60 * 60 * 1000);
        const initialCount = this.messages.length;
        
        // Encontrar el primer mensaje que no es viejo
        let firstValidIndex = 0;
        while (firstValidIndex < this.messages.length) {
            const messageTime = new Date(this.messages[firstValidIndex].timestamp).getTime();
            if (messageTime >= cutoffTime) break;
            firstValidIndex++;
        }
        
        // Eliminar mensajes viejos
        if (firstValidIndex > 0) {
            const removed = this.messages.splice(0, firstValidIndex);
            
            // Reconstruir índices
            this.messageIndex.clear();
            this.messages.forEach((msg, index) => {
                this.messageIndex.set(msg.id, index);
            });
            
            // Limpiar índices de usuario
            for (const [userId, msgIds] of this.userMessages) {
                const validMsgIds = msgIds.filter(msgId => {
                    const msg = this.getMessage(msgId);
                    return msg && new Date(msg.timestamp).getTime() >= cutoffTime;
                });
                this.userMessages.set(userId, validMsgIds);
            }
            
            console.log(`🧹 Limpiados ${removed.length} mensajes antiguos`);
            return removed.length;
        }
        
        return 0;
    }

    cleanInactiveUsers(timeoutMinutes = 10) {
        const cutoffTime = Date.now() - (timeoutMinutes * 60 * 1000);
        const inactiveUsers = [];
        
        for (const [socketId, user] of this.users) {
            if (user.lastActivity < cutoffTime) {
                inactiveUsers.push({ socketId, user });
            }
        }
        
        inactiveUsers.forEach(({ socketId }) => {
            this.removeUser(socketId);
        });
        
        return inactiveUsers.length;
    }

    // ===== ESTADÍSTICAS =====
    getStats() {
        const now = Date.now();
        const uptime = now - this.connectionStats.startTime;
        
        return {
            users: {
                total: this.users.size,
                unique: this.userSockets.size,
                typing: this.typingUsers.size
            },
            messages: {
                total: this.connectionStats.totalMessages,
                stored: this.messages.length,
                averageLength: this.calculateAverageMessageLength()
            },
            performance: {
                uptime: this.formatUptime(uptime),
                memoryUsage: process.memoryUsage(),
                peakUsers: this.connectionStats.peakUsers,
                totalConnections: this.connectionStats.totalConnections
            },
            limits: {
                maxMessages: MAX_MESSAGES,
                maxMessageLength: MAX_MESSAGE_LENGTH,
                retentionHours: MESSAGE_RETENTION_HOURS,
                rateLimit: `${RATE_LIMIT_MAX}/${RATE_LIMIT_WINDOW}ms`
            }
        };
    }

    // ===== UTILIDADES =====
    generateId(prefix) {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    sanitizeUsername(username) {
        if (!username || typeof username !== 'string') {
            return `Usuario${Math.floor(Math.random() * 10000)}`;
        }
        
        // Trim y limitar longitud
        let sanitized = username.trim();
        if (sanitized.length > MAX_USERNAME_LENGTH) {
            sanitized = sanitized.substring(0, MAX_USERNAME_LENGTH);
        }
        
        // Eliminar caracteres peligrosos
        sanitized = sanitized.replace(/[<>'"&]/g, '');
        
        // Asegurar que no esté vacío
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

    calculateAverageMessageLength() {
        if (this.messages.length === 0) return 0;
        const totalLength = this.messages.reduce((sum, msg) => sum + (msg.text?.length || 0), 0);
        return Math.round(totalLength / this.messages.length);
    }

    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    }

    // ===== BACKUP Y RESTAURACIÓN =====
    getSnapshot() {
        return {
            users: Array.from(this.users.values()),
            messages: this.messages,
            stats: this.connectionStats,
            timestamp: Date.now()
        };
    }

    restoreSnapshot(snapshot) {
        if (!snapshot || !snapshot.messages) return false;
        
        try {
            this.messages = snapshot.messages;
            this.connectionStats = snapshot.stats || this.connectionStats;
            
            // Reconstruir índices
            this.messageIndex.clear();
            this.userMessages.clear();
            
            this.messages.forEach((msg, index) => {
                this.messageIndex.set(msg.id, index);
                
                if (!this.userMessages.has(msg.userId)) {
                    this.userMessages.set(msg.userId, []);
                }
                this.userMessages.get(msg.userId).push(msg.id);
            });
            
            console.log(`✅ Snapshot restaurado: ${this.messages.length} mensajes`);
            return true;
        } catch (error) {
            console.error('Error restaurando snapshot:', error);
            return false;
        }
    }
}

// ===== INICIALIZACIÓN DEL SERVIDOR =====
const storage = new ChatStorage();
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // 1MB
    connectTimeout: 45000,
    allowEIO3: true
});

// ===== AUTO-PING PARA MANTENER ACTIVO EN RENDER =====
let autoPingInterval;
let cleanupInterval;

function startAutoPing() {
    console.log(`🔄 Configurando auto-ping cada ${AUTO_PING_INTERVAL / 60000} minutos...`);
    
    autoPingInterval = setInterval(async () => {
        try {
            console.log(`🔍 Realizando health check a ${RENDER_URL}/health`);
            const response = await axios.get(`${RENDER_URL}/health`, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'FoxWeb-Chat-AutoPing/1.0',
                    'Cache-Control': 'no-cache'
                }
            });
            
            console.log(`✅ Health check exitoso: ${response.status} ${response.statusText}`);
            
            // Verificar estado de salud del servidor
            const stats = storage.getStats();
            if (stats.users.total > 50) {
                console.log(`📊 Estadísticas: ${stats.users.total} usuarios, ${stats.messages.stored} mensajes`);
            }
            
        } catch (error) {
            console.error(`❌ Error en health check: ${error.message}`);
            
            // Intentar reconectar o notificar
            if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                console.warn('⚠️ Servidor no responde, verificando estado interno...');
                // El servidor podría estar reiniciándose
            }
        }
    }, AUTO_PING_INTERVAL);
    
    // Realizar primer ping inmediato
    setTimeout(() => {
        axios.get(`${RENDER_URL}/health`).catch(() => {
            console.log('🔄 Primer health check falló, continuando...');
        });
    }, 5000);
}

function startCleanupSchedule() {
    console.log('🧹 Iniciando limpieza programada...');
    
    cleanupInterval = setInterval(() => {
        try {
            // Limpiar mensajes antiguos
            const cleanedMessages = storage.cleanOldMessages();
            
            // Limpiar usuarios inactivos
            const cleanedUsers = storage.cleanInactiveUsers(INACTIVE_USER_TIMEOUT / 60000);
            
            // Limpiar contadores de rate limiting antiguos
            const now = Date.now();
            for (const [userId, stats] of storage.messageCounts) {
                if (now - stats.windowStart > 3600000) { // 1 hora
                    storage.messageCounts.delete(userId);
                }
            }
            
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
    const clientIp = socket.handshake.address || 
                    socket.handshake.headers['x-forwarded-for'] || 
                    'unknown';
    
    console.log(`🔗 Nueva conexión: ${socket.id} desde ${clientIp}`);
    
    // Enviar bienvenida con configuración
    socket.emit('welcome', {
        server: 'FoxWeb Chat v5.0',
        timestamp: new Date().toISOString(),
        features: [
            'Chat en tiempo real',
            'Historial de 24 horas',
            'Indicador de escritura',
            'Cambio de nombre',
            'Emojis integrados',
            'Temas claro/oscuro'
        ],
        limits: {
            maxMessageLength: MAX_MESSAGE_LENGTH,
            maxUsernameLength: MAX_USERNAME_LENGTH,
            rateLimit: RATE_LIMIT_MAX
        },
        message: 'Conectado al servidor. Por favor, ingresa tu nombre de usuario.'
    });

    // ===== EVENTO: UNIRSE AL CHAT =====
    socket.on('join', (userData, callback) => {
        try {
            // Validar datos del usuario
            if (!userData || typeof userData !== 'object') {
                socket.emit('error', { code: 'INVALID_DATA', message: 'Datos de usuario inválidos' });
                return;
            }
            
            const username = userData.username?.trim();
            const userId = userData.userId || storage.generateId('user');
            
            if (!username || username.length < 2) {
                socket.emit('error', { 
                    code: 'INVALID_USERNAME', 
                    message: 'El nombre debe tener al menos 2 caracteres' 
                });
                return;
            }
            
            if (username.length > MAX_USERNAME_LENGTH) {
                socket.emit('error', { 
                    code: 'USERNAME_TOO_LONG', 
                    message: `El nombre no puede exceder ${MAX_USERNAME_LENGTH} caracteres` 
                });
                return;
            }
            
            // Verificar si el nombre ya está en uso (excluyendo al mismo usuario)
            const existingUser = storage.getUserByUsername(username);
            if (existingUser && existingUser.userId !== userId) {
                // Sugerir nombre alternativo
                const altUsername = `${username}${Math.floor(Math.random() * 1000)}`;
                socket.emit('error', { 
                    code: 'USERNAME_TAKEN', 
                    message: 'Nombre en uso', 
                    suggestion: altUsername 
                });
                return;
            }
            
            // Registrar usuario
            const user = storage.addUser(socket.id, { username, userId }, clientIp);
            
            // Unir a sala general
            socket.join('general');
            
            // Enviar confirmación al usuario
            if (typeof callback === 'function') {
                callback({
                    success: true,
                    userId: user.userId,
                    username: user.username,
                    avatarColor: user.avatarColor,
                    onlineCount: storage.users.size
                });
            }
            
            // Notificar a todos EXCEPTO al nuevo usuario
            socket.broadcast.emit('userJoined', {
                userId: user.userId,
                username: user.username,
                timestamp: new Date().toISOString(),
                onlineCount: storage.users.size,
                system: true
            });
            
            // Enviar historial al nuevo usuario
            const history = storage.getHistory(100);
            socket.emit('history', {
                messages: history,
                total: storage.messages.length,
                hasMore: storage.messages.length > 100
            });
            
            // Enviar usuarios en línea
            const onlineUsers = Array.from(storage.users.values()).map(u => ({
                userId: u.userId,
                username: u.username,
                avatarColor: u.avatarColor,
                status: u.status
            }));
            
            io.emit('onlineUsers', {
                users: onlineUsers,
                count: onlineUsers.length,
                timestamp: new Date().toISOString()
            });
            
            console.log(`👋 ${user.username} (${user.userId}) se unió al chat. Total: ${storage.users.size}`);
            
        } catch (error) {
            console.error('Error en evento join:', error);
            socket.emit('error', { 
                code: 'SERVER_ERROR', 
                message: 'Error interno del servidor' 
            });
        }
    });

    // ===== EVENTO: ENVIAR MENSAJE =====
    socket.on('message', (messageData, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) {
                socket.emit('error', { 
                    code: 'NOT_AUTHENTICATED', 
                    message: 'Debes unirte al chat primero' 
                });
                return;
            }
            
            // Validar mensaje
            const text = messageData.text?.trim();
            if (!text) {
                socket.emit('error', { 
                    code: 'EMPTY_MESSAGE', 
                    message: 'El mensaje no puede estar vacío' 
                });
                return;
            }
            
            if (text.length > MAX_MESSAGE_LENGTH) {
                socket.emit('error', { 
                    code: 'MESSAGE_TOO_LONG', 
                    message: `El mensaje no puede exceder ${MAX_MESSAGE_LENGTH} caracteres` 
                });
                return;
            }
            
            // Verificar rate limiting
            const rateCheck = storage.canSendMessage(user.userId);
            if (!rateCheck.allowed) {
                socket.emit('error', { 
                    code: 'RATE_LIMITED', 
                    message: `Espera ${rateCheck.waitTime} segundos antes de enviar otro mensaje`,
                    waitTime: rateCheck.waitTime
                });
                return;
            }
            
            // Crear objeto de mensaje
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
                system: false,
                edited: false,
                reactions: {}
            };
            
            // Si hay mención de usuario, extraerla
            const mentionMatch = text.match(/@(\w+)/);
            if (mentionMatch) {
                message.mentions = [mentionMatch[1]];
            }
            
            // Agregar al almacenamiento
            const savedMessage = storage.addMessage(message);
            if (!savedMessage) {
                socket.emit('error', { 
                    code: 'STORAGE_ERROR', 
                    message: 'Error al guardar el mensaje' 
                });
                return;
            }
            
            // Actualizar actividad del usuario
            storage.updateUserActivity(socket.id);
            
            // Si estaba escribiendo, detenerlo
            storage.stopTyping(user.userId);
            socket.broadcast.emit('stopTyping', {
                userId: user.userId,
                username: user.username
            });
            
            // Enviar mensaje a todos
            io.emit('message', savedMessage);
            
            // Confirmación al remitente
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
            socket.emit('error', { 
                code: 'SERVER_ERROR', 
                message: 'Error al enviar mensaje' 
            });
        }
    });

    // ===== EVENTO: USUARIO ESCRIBIENDO =====
    socket.on('typing', () => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) return;
            
            storage.updateUserActivity(socket.id);
            
            const typingUsers = storage.startTyping(user.userId);
            
            // Notificar a todos excepto al usuario actual
            socket.broadcast.emit('typing', {
                userId: user.userId,
                username: user.username,
                typingUsers: typingUsers.filter(u => u.userId !== user.userId)
            });
            
        } catch (error) {
            console.error('Error en evento typing:', error);
        }
    });

    // ===== EVENTO: DEJAR DE ESCRIBIR =====
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

    // ===== EVENTO: CAMBIAR NOMBRE =====
    socket.on('changeUsername', (data, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (!user) {
                socket.emit('error', { 
                    code: 'NOT_AUTHENTICATED', 
                    message: 'Usuario no autenticado' 
                });
                return;
            }
            
            const newUsername = data.newUsername?.trim();
            if (!newUsername || newUsername.length < 2) {
                socket.emit('error', { 
                    code: 'INVALID_USERNAME', 
                    message: 'Nombre inválido' 
                });
                return;
            }
            
            if (newUsername.length > MAX_USERNAME_LENGTH) {
                socket.emit('error', { 
                    code: 'USERNAME_TOO_LONG', 
                    message: `Nombre demasiado largo (máx. ${MAX_USERNAME_LENGTH} caracteres)` 
                });
                return;
            }
            
            // Verificar si el nuevo nombre ya está en uso
            const existingUser = storage.getUserByUsername(newUsername);
            if (existingUser && existingUser.userId !== user.userId) {
                socket.emit('error', { 
                    code: 'USERNAME_TAKEN', 
                    message: 'El nombre ya está en uso' 
                });
                return;
            }
            
            const oldUsername = user.username;
            user.username = newUsername;
            user.avatarColor = storage.generateAvatarColor(newUsername);
            
            // Actualizar mensajes existentes
            const userMessages = storage.getMessagesByUser(user.userId);
            userMessages.forEach(msg => {
                msg.username = newUsername;
            });
            
            // Notificar a todos
            io.emit('usernameChanged', {
                userId: user.userId,
                oldUsername: oldUsername,
                newUsername: newUsername,
                timestamp: new Date().toISOString(),
                avatarColor: user.avatarColor
            });
            
            // Actualizar lista de usuarios en línea
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
            socket.emit('error', { 
                code: 'SERVER_ERROR', 
                message: 'Error al cambiar nombre' 
            });
        }
    });

    // ===== EVENTO: PING/PONG =====
    socket.on('ping', (data, callback) => {
        try {
            const user = storage.getUser(socket.id);
            if (user) {
                storage.updateUserActivity(socket.id);
            }
            
            const response = {
                serverTime: new Date().toISOString(),
                timestamp: Date.now(),
                uptime: process.uptime(),
                latency: data?.clientTimestamp ? Date.now() - data.clientTimestamp : null
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

    // ===== EVENTO: SOLICITAR MÁS MENSAJES (PAGINACIÓN) =====
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

    // ===== EVENTO: SOLICITAR USUARIOS EN LÍNEA =====
    socket.on('getOnlineUsers', (callback) => {
        try {
            const onlineUsers = Array.from(storage.users.values()).map(u => ({
                userId: u.userId,
                username: u.username,
                avatarColor: u.avatarColor,
                status: u.status,
                lastActivity: u.lastActivity
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

    // ===== EVENTO: ESTADÍSTICAS DEL SERVIDOR =====
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

    // ===== EVENTO: DESCONEXIÓN =====
    socket.on('disconnect', (reason) => {
        try {
            const user = storage.removeUser(socket.id);
            
            if (user) {
                // Notificar a todos
                socket.broadcast.emit('userLeft', {
                    userId: user.userId,
                    username: user.username,
                    timestamp: new Date().toISOString(),
                    onlineCount: storage.users.size,
                    reason: reason
                });
                
                // Actualizar contador de usuarios
                io.emit('userCount', storage.users.size);
                
                console.log(`👋 ${user.username} desconectado (${reason}). Quedan: ${storage.users.size}`);
            }
            
        } catch (error) {
            console.error('Error en evento disconnect:', error);
        }
    });

    // ===== EVENTO: ERROR DEL SOCKET =====
    socket.on('error', (error) => {
        console.error(`Socket error ${socket.id}:`, error);
    });
});

// ===== RUTAS HTTP/API =====

// Health check para Render (sin rate limiting)
app.get('/health', (req, res) => {
    const stats = storage.getStats();
    
    res.status(200).json({
        status: 'healthy',
        server: 'FoxWeb Chat v5.0',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: NODE_ENV,
        stats: {
            users: stats.users.total,
            messages: stats.messages.stored,
            uptime: stats.performance.uptime
        },
        checks: {
            memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024, // < 500MB
            storage: storage.messages.length < MAX_MESSAGES * 0.9,
            connections: io.engine.clientsCount < 1000
        }
    });
});

// Ruta principal - servir cliente
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
            'Rate limiting inteligente',
            'Historial de 24 horas con paginación',
            'Indicador de escritura en tiempo real',
            'Cambio de nombre dinámico',
            'Auto-ping para Render',
            'Sanitización XSS',
            'Backup en memoria',
            'Múltiples temas (claro/oscuro)',
            'Soporte para emojis'
        ],
        endpoints: [
            '/health - Health check',
            '/status - Estado del servidor',
            '/stats - Estadísticas detalladas',
            '/api/messages - API de mensajes',
            '/api/users - API de usuarios'
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
                connectedSockets: io.engine.clientsCount,
                activeRooms: io.sockets.adapter.rooms.size
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

// API: Limpieza manual (solo en desarrollo)
app.post('/api/cleanup', apiLimiter, (req, res) => {
    if (NODE_ENV !== 'development' && !req.query.admin) {
        return res.status(403).json({
            success: false,
            error: 'Acceso denegado'
        });
    }
    
    try {
        const cleanedMessages = storage.cleanOldMessages();
        const cleanedUsers = storage.cleanInactiveUsers();
        
        res.json({
            success: true,
            cleaned: {
                messages: cleanedMessages,
                users: cleanedUsers
            },
            remaining: {
                messages: storage.messages.length,
                users: storage.users.size
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Backup del estado del servidor
app.get('/api/backup', apiLimiter, (req, res) => {
    if (NODE_ENV !== 'development') {
        return res.status(403).json({
            success: false,
            error: 'Solo disponible en desarrollo'
        });
    }
    
    try {
        const snapshot = storage.getSnapshot();
        
        res.json({
            success: true,
            snapshot: {
                ...snapshot,
                messages: snapshot.messages.map(m => ({
                    ...m,
                    text: m.text.substring(0, 50) + (m.text.length > 50 ? '...' : '')
                }))
            },
            size: JSON.stringify(snapshot).length,
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
            '/api/users',
            '/api/cleanup (dev only)',
            '/api/backup (dev only)'
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
    🛡️  Seguridad: Helmet, CORS, Rate limiting
    
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
    
    // Guardar snapshot si es necesario
    if (storage.messages.length > 0) {
        console.log(`💾 Guardando snapshot con ${storage.messages.length} mensajes...`);
        // En producción, aquí guardaríamos en disco o base de datos
    }
    
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
    // Continuar ejecución para mantener el servicio
    // En producción, podríamos reiniciar el proceso
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ PROMESA RECHAZADA NO MANEJADA:', reason);
});

// Manejo de advertencias
process.on('warning', (warning) => {
    console.warn('⚠️ ADVERTENCIA DE NODE:', warning);
});

// Monitoreo de memoria
if (NODE_ENV === 'production') {
    setInterval(() => {
        const memory = process.memoryUsage();
        const usedMB = Math.round(memory.heapUsed / 1024 / 1024);
        const totalMB = Math.round(memory.heapTotal / 1024 / 1024);
        
        if (usedMB > 500) { // > 500MB
            console.warn(`⚠️ Uso alto de memoria: ${usedMB}MB / ${totalMB}MB`);
            
            // Forzar garbage collection si está disponible
            if (global.gc) {
                console.log('🗑️  Forzando garbage collection...');
                global.gc();
            }
        }
    }, 60000); // Cada minuto
}