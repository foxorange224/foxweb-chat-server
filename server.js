// server.js - FoxWeb Chat Server v4.0
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { body, validationResult } = require('express-validator');

const app = express();

// ===== CONFIGURACIÓN DE SEGURIDAD =====
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "wss:", "ws:"]
    }
  }
}));

app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://foxweb.vercel.app', 'https://foxweb-chat.vercel.app']
    : '*',
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));

// Rate limiting por IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { error: 'Demasiadas solicitudes desde esta IP' }
});

const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 10,
  message: { error: 'Demasiados intentos de autenticación' }
});

app.use('/api/', apiLimiter);
app.use('/auth/', authLimiter);

// ===== ALMACENAMIENTO OPTIMIZADO Y SEGURO =====
class SecureChatStorage {
  constructor() {
    this.users = new Map(); // socket.id -> userData
    this.userIds = new Map(); // userId -> socket.id
    this.messages = [];
    this.typingUsers = new Map();
    this.userMessageCounts = new Map(); // userId -> {count, windowStart}
    this.bannedIPs = new Map(); // IP -> {bannedUntil, reason}
  }

  // Sanitización de entrada
  sanitizeInput(input, type = 'string') {
    if (!input) return '';
    
    if (type === 'string') {
      // Eliminar etiquetas HTML/script peligrosas
      return String(input)
        .replace(/[<>]/g, c => ({ '<': '&lt;', '>': '&gt;' }[c]))
        .substring(0, 500)
        .trim();
    }
    
    if (type === 'username') {
      return String(input)
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .substring(0, 20)
        .trim();
    }
    
    return String(input).substring(0, 1000).trim();
  }

  // Validación de rate limiting por usuario
  checkRateLimit(userId, maxMessages = 3, timeWindow = 5000) {
    const now = Date.now();
    const userData = this.userMessageCounts.get(userId) || { count: 0, windowStart: now };
    
    if (now - userData.windowStart > timeWindow) {
      userData.count = 1;
      userData.windowStart = now;
    } else {
      userData.count++;
    }
    
    this.userMessageCounts.set(userId, userData);
    return userData.count <= maxMessages;
  }

  // Validación de mensaje
  validateMessage(message) {
    if (!message || typeof message !== 'object') return false;
    
    const required = ['text', 'username', 'userId'];
    if (!required.every(field => field in message)) return false;
    
    if (typeof message.text !== 'string' || message.text.length > 500) return false;
    if (typeof message.username !== 'string' || message.username.length > 20) return false;
    
    // Validar que el texto no sea solo espacios
    if (!message.text.trim()) return false;
    
    return true;
  }

  addUser(socketId, userData, ip) {
    // Verificar si IP está baneada
    const banInfo = this.bannedIPs.get(ip);
    if (banInfo && banInfo.bannedUntil > Date.now()) {
      throw new Error(`IP baneada hasta ${new Date(banInfo.bannedUntil).toLocaleString()}: ${banInfo.reason}`);
    }
    
    const sanitizedUsername = this.sanitizeInput(userData.username, 'username');
    if (!sanitizedUsername || sanitizedUsername.length < 2) {
      throw new Error('Nombre de usuario inválido');
    }
    
    const user = {
      socketId,
      userId: userData.userId || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      username: sanitizedUsername,
      ip: ip,
      joined: Date.now(),
      lastActive: Date.now(),
      messageCount: 0,
      warnings: 0
    };
    
    this.users.set(socketId, user);
    this.userIds.set(user.userId, socketId);
    return user;
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      this.users.delete(socketId);
      this.userIds.delete(user.userId);
      this.typingUsers.delete(user.username);
      this.userMessageCounts.delete(user.userId);
    }
    return user;
  }

  addMessage(message) {
    // Validación adicional del mensaje
    if (!this.validateMessage(message)) {
      throw new Error('Mensaje inválido');
    }
    
    // Aplicar rate limiting
    if (!this.checkRateLimit(message.userId)) {
      throw new Error('Demasiados mensajes en poco tiempo. Espera unos segundos.');
    }
    
    const sanitizedMessage = {
      ...message,
      text: this.sanitizeInput(message.text, 'string'),
      timestamp: new Date().toISOString(),
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    this.messages.push(sanitizedMessage);
    
    // Limitar tamaño manteniendo los más recientes
    const MAX_MESSAGES = 2000;
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    
    return sanitizedMessage;
  }

  banIP(ip, durationMinutes = 60, reason = 'Violación de términos') {
    const bannedUntil = Date.now() + (durationMinutes * 60 * 1000);
    this.bannedIPs.set(ip, { bannedUntil, reason });
    
    // Limpiar baneos expirados periódicamente
    setTimeout(() => {
      const banInfo = this.bannedIPs.get(ip);
      if (banInfo && banInfo.bannedUntil < Date.now()) {
        this.bannedIPs.delete(ip);
      }
    }, durationMinutes * 60 * 1000);
  }

  getStats() {
    return {
      users: this.users.size,
      messages: this.messages.length,
      typingUsers: this.typingUsers.size,
      bannedIPs: this.bannedIPs.size
    };
  }
}

// ===== CONFIGURACIÓN DEL SERVIDOR =====
const MESSAGE_RETENTION_HOURS = 24;
const CLEANUP_INTERVAL = 30 * 60 * 1000; // 30 minutos
const MAX_MESSAGES_PER_USER = 3;
const TIME_WINDOW_MS = 5000; // 5 segundos

const storage = new SecureChatStorage();

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? ['https://foxweb.vercel.app', 'https://foxweb-chat.vercel.app']
      : '*',
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6 // 1MB máximo para transferencias
});

// ===== MIDDLEWARE DE SOCKET.IO PARA SEGURIDAD =====
io.use((socket, next) => {
  const clientIP = socket.handshake.address;
  console.log(`🔍 Conexión desde IP: ${clientIP}`);
  
  // Aquí podrías agregar validaciones adicionales de IP
  // Por ejemplo, verificar listas negras
  
  next();
});

// ===== EVENTOS DE SOCKET.IO MEJORADOS =====
io.on('connection', (socket) => {
  const clientIP = socket.handshake.address;
  console.log(`🔗 Nuevo usuario conectado: ${socket.id} desde ${clientIP}`);
  
  // Enviar estadísticas iniciales
  socket.emit('userCount', storage.users.size);
  socket.emit('history', {
    messages: storage.messages.slice(-50),
    total: storage.messages.length
  });

  // Unirse al chat
  socket.on('join', (userData) => {
    try {
      // Validación del esquema
      if (!userData || !userData.username || typeof userData.username !== 'string') {
        socket.emit('error', { 
          code: 'INVALID_DATA',
          message: 'Datos de usuario inválidos' 
        });
        return;
      }

      const user = storage.addUser(socket.id, userData, clientIP);
      
      // Asociar IP con socket
      socket.data.ip = clientIP;
      socket.data.userId = user.userId;
      
      // Notificar a todos
      socket.broadcast.emit('userJoined', {
        username: user.username,
        userId: user.userId,
        onlineCount: storage.users.size,
        timestamp: new Date().toISOString()
      });
      
      // Actualizar todos los clientes
      updateOnlineUsers();
      
      console.log(`👋 ${user.username} se unió al chat. Total: ${storage.users.size}`);
      
    } catch (error) {
      console.error('Error en join:', error.message);
      socket.emit('error', { 
        code: 'JOIN_ERROR', 
        message: error.message 
      });
      
      // Si es error de IP baneada, desconectar
      if (error.message.includes('baneada')) {
        setTimeout(() => socket.disconnect(true), 2000);
      }
    }
  });

  // Recibir mensaje con validación
  socket.on('message', (messageData) => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) {
        socket.emit('error', { 
          code: 'UNAUTHENTICATED',
          message: 'Usuario no autenticado' 
        });
        return;
      }

      // Validar esquema del mensaje
      if (!messageData || typeof messageData.text !== 'string') {
        socket.emit('error', { 
          code: 'INVALID_MESSAGE',
          message: 'Mensaje inválido' 
        });
        return;
      }

      // Verificar rate limiting (a nivel servidor también)
      if (!storage.checkRateLimit(user.userId, MAX_MESSAGES_PER_USER, TIME_WINDOW_MS)) {
        socket.emit('error', { 
          code: 'RATE_LIMITED',
          message: 'Demasiados mensajes. Espera unos segundos.',
          retryAfter: 5
        });
        return;
      }

      // Crear mensaje sanitizado
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        username: user.username,
        userId: user.userId,
        text: messageData.text,
        timestamp: new Date().toISOString(),
        type: messageData.type || 'text', // 'text', 'image', 'system'
        metadata: messageData.metadata || {}
      };

      // Procesar diferentes tipos de mensajes
      if (messageData.type === 'image') {
        // Validar imágenes
        if (!messageData.metadata || !messageData.metadata.url) {
          socket.emit('error', { 
            code: 'INVALID_IMAGE',
            message: 'URL de imagen inválida' 
          });
          return;
        }
        
        // Verificar que la URL sea segura
        if (!isValidImageUrl(messageData.metadata.url)) {
          socket.emit('error', { 
            code: 'UNSAFE_IMAGE',
            message: 'URL de imagen no permitida' 
          });
          return;
        }
        
        // Limitar tamaño de imágenes
        if (messageData.metadata.size > 5 * 1024 * 1024) { // 5MB
          socket.emit('error', { 
            code: 'IMAGE_TOO_LARGE',
            message: 'La imagen es demasiado grande (máximo 5MB)' 
          });
          return;
        }
      }

      // Guardar mensaje
      const savedMessage = storage.addMessage(message);
      
      // Eliminar usuario de typing
      storage.typingUsers.delete(user.username);
      
      // Emitir stopTyping
      socket.broadcast.emit('stopTyping', {
        username: user.username,
        userId: user.userId
      });
      
      // Enviar mensaje a todos
      io.emit('message', savedMessage);
      
      console.log(`💬 Mensaje de ${user.username} (${messageData.type || 'text'})`);
      
    } catch (error) {
      console.error('Error procesando mensaje:', error.message);
      
      if (error.message.includes('Demasiados mensajes')) {
        // Advertencia por rate limiting
        socket.emit('warning', {
          code: 'RATE_LIMIT_WARNING',
          message: error.message,
          type: 'rate_limit'
        });
        
        // Incrementar advertencias
        const user = storage.getUser(socket.id);
        if (user) {
          user.warnings++;
          
          // Banear después de 3 advertencias
          if (user.warnings >= 3) {
            storage.banIP(clientIP, 60, 'Demasiadas violaciones de rate limiting');
            socket.emit('error', {
              code: 'BANNED',
              message: 'Tu IP ha sido baneada temporalmente por 60 minutos',
              duration: 60
            });
            setTimeout(() => socket.disconnect(true), 3000);
          }
        }
      } else {
        socket.emit('error', { 
          code: 'MESSAGE_ERROR',
          message: 'Error al procesar mensaje' 
        });
      }
    }
  });

  // Typing con debouncing
  let typingTimeout;
  socket.on('typing', () => {
    clearTimeout(typingTimeout);
    
    const user = storage.getUser(socket.id);
    if (!user) return;
    
    // Usar debouncing para evitar spam
    typingTimeout = setTimeout(() => {
      storage.typingUsers.set(user.username, Date.now());
      
      const typingUsersList = Array.from(storage.typingUsers.keys())
        .filter(username => username !== user.username);
      
      socket.broadcast.emit('typing', {
        username: user.username,
        typingUsers: typingUsersList
      });
      
      // Auto-eliminar después de 5 segundos
      setTimeout(() => {
        if (storage.typingUsers.get(user.username)) {
          storage.typingUsers.delete(user.username);
          socket.broadcast.emit('stopTyping', {
            username: user.username
          });
        }
      }, 5000);
    }, 300); // Debounce de 300ms
  });

  socket.on('stopTyping', () => {
    const user = storage.getUser(socket.id);
    if (!user) return;
    
    clearTimeout(typingTimeout);
    storage.typingUsers.delete(user.username);
    socket.broadcast.emit('stopTyping', { username: user.username });
  });

  // Cambio de nombre con validación
  socket.on('usernameChange', (data) => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) return;
      
      if (!data.newUsername || data.newUsername.length < 2 || data.newUsername.length > 20) {
        socket.emit('error', { 
          code: 'INVALID_USERNAME',
          message: 'Nombre de usuario inválido (2-20 caracteres)' 
        });
        return;
      }
      
      // Sanitizar nuevo nombre
      const newUsername = storage.sanitizeInput(data.newUsername, 'username');
      
      // Verificar si el nombre ya está en uso
      const isNameTaken = Array.from(storage.users.values())
        .some(u => u.username.toLowerCase() === newUsername.toLowerCase() && u.userId !== user.userId);
      
      if (isNameTaken) {
        socket.emit('error', { 
          code: 'USERNAME_TAKEN',
          message: 'Este nombre ya está en uso' 
        });
        return;
      }
      
      const oldUsername = user.username;
      user.username = newUsername;
      
      // Actualizar en typingUsers
      if (storage.typingUsers.has(oldUsername)) {
        storage.typingUsers.delete(oldUsername);
        storage.typingUsers.set(newUsername, Date.now());
      }
      
      // Actualizar mensajes existentes
      storage.messages.forEach(msg => {
        if (msg.userId === user.userId) {
          msg.username = newUsername;
        }
      });
      
      // Notificar a todos
      io.emit('usernameChanged', {
        oldUsername,
        newUsername,
        userId: user.userId,
        timestamp: new Date().toISOString()
      });
      
      updateOnlineUsers();
      
      console.log(`📝 ${oldUsername} → ${newUsername}`);
      
    } catch (error) {
      console.error('Error en cambio de nombre:', error);
      socket.emit('error', { 
        code: 'USERNAME_CHANGE_ERROR',
        message: 'Error al cambiar nombre' 
      });
    }
  });

  // Ping/pong para medir latencia
  socket.on('ping', (data) => {
    socket.emit('pong', { 
      timestamp: data.timestamp,
      serverTime: Date.now() 
    });
  });

  // Solicitar usuarios en línea
  socket.on('requestOnlineUsers', () => {
    try {
      const onlineUsers = Array.from(storage.users.values()).map(u => ({
        username: u.username,
        userId: u.userId,
        lastActive: u.lastActive
      }));
      socket.emit('onlineUsers', onlineUsers);
    } catch (error) {
      console.error('Error en requestOnlineUsers:', error);
    }
  });

  // Solicitar estadísticas del servidor
  socket.on('requestServerStats', () => {
    try {
      const stats = storage.getStats();
      socket.emit('serverStats', {
        ...stats,
        uptime: process.uptime(),
        memory: process.memoryUsage()
      });
    } catch (error) {
      console.error('Error en requestServerStats:', error);
    }
  });

  // Desconexión
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Usuario desconectado: ${socket.id}, razón: ${reason}`);
    
    const user = storage.removeUser(socket.id);
    if (user) {
      io.emit('userLeft', {
        username: user.username,
        userId: user.userId,
        onlineCount: storage.users.size,
        reason: reason,
        timestamp: new Date().toISOString()
      });
      
      updateOnlineUsers();
    }
  });

  // Error handler
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// ===== FUNCIONES AUXILIARES =====
function updateOnlineUsers() {
  try {
    const onlineUsers = Array.from(storage.users.values()).map(u => ({
      username: u.username,
      userId: u.userId
    }));
    
    io.emit('onlineUsers', onlineUsers);
    io.emit('userCount', onlineUsers.length);
  } catch (error) {
    console.error('Error en updateOnlineUsers:', error);
  }
}

function isValidImageUrl(url) {
  try {
    const parsed = new URL(url);
    const allowedProtocols = ['http:', 'https:'];
    const allowedDomains = [
      'i.imgur.com',
      'images.unsplash.com',
      'cdn.discordapp.com'
    ];
    
    return allowedProtocols.includes(parsed.protocol) &&
           allowedDomains.some(domain => parsed.hostname.endsWith(domain));
  } catch {
    return false;
  }
}

// ===== RUTAS HTTP =====
app.get('/', (req, res) => {
  const stats = storage.getStats();
  
  res.json({
    status: 'active',
    server: 'FoxWeb Chat Server v4.0',
    version: '4.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    features: [
      'Chat en tiempo real con WebSockets',
      'Rate limiting y protección contra spam',
      'Sanitización de entrada XSS',
      'Soporte para imágenes y emojis',
      'Historial de 24 horas',
      'Notificaciones en tiempo real'
    ],
    security: {
      rateLimiting: true,
      xssProtection: true,
      inputSanitization: true,
      cors: true,
      helmet: true
    },
    stats: stats,
    limits: {
      maxMessageLength: 500,
      maxMessagesPerUser: `${MAX_MESSAGES_PER_USER}/5s`,
      imageSizeLimit: '5MB',
      retentionHours: MESSAGE_RETENTION_HOURS
    }
  });
});

app.get('/stats', (req, res) => {
  const stats = storage.getStats();
  
  res.json({
    status: 'active',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ...stats,
    memoryUsage: process.memoryUsage(),
    nodeVersion: process.version
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      storage: storage.messages.length >= 0,
      connections: storage.users.size >= 0,
      memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024 // < 500MB
    }
  });
});

// Ruta para administración (protegida)
app.get('/admin/stats', (req, res) => {
  const auth = req.headers.authorization;
  
  // Autenticación básica para admin
  if (auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(403).json({ error: 'No autorizado' });
  }
  
  const detailedStats = {
    ...storage.getStats(),
    users: Array.from(storage.users.values()).map(u => ({
      username: u.username,
      ip: u.ip,
      joined: u.joined,
      messageCount: u.messageCount,
      warnings: u.warnings
    })),
    bannedIPs: Array.from(storage.bannedIPs.entries()).map(([ip, data]) => ({
      ip,
      ...data
    })),
    recentMessages: storage.messages.slice(-10)
  };
  
  res.json(detailedStats);
});

// Limpieza periódica de mensajes antiguos
setInterval(() => {
  try {
    const cutoff = Date.now() - (MESSAGE_RETENTION_HOURS * 60 * 60 * 1000);
    const initialCount = storage.messages.length;
    
    storage.messages = storage.messages.filter(msg => {
      const msgTime = new Date(msg.timestamp).getTime();
      return msgTime >= cutoff;
    });
    
    const removed = initialCount - storage.messages.length;
    if (removed > 0) {
      console.log(`🧹 Limpieza automática: ${removed} mensajes antiguos eliminados`);
    }
  } catch (error) {
    console.error('Error en limpieza automática:', error);
  }
}, CLEANUP_INTERVAL);

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FoxWeb Chat Server v4.0 iniciado`);
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`🔒 Características de seguridad activadas`);
  console.log(`⏳ Retención de mensajes: ${MESSAGE_RETENTION_HOURS} horas`);
  console.log(`⚡ Rate limiting: ${MAX_MESSAGES_PER_USER} mensajes/5s por usuario`);
  
  // Iniciar ping automático para mantener activo en render.com
  if (process.env.RENDER_EXTERNAL_URL) {
    const keepAlive = require('./keepAlive');
    keepAlive.start(process.env.RENDER_EXTERNAL_URL);
  }
});

// ===== MANEJO DE SEÑALES =====
function gracefulShutdown() {
  console.log('🛑 Iniciando apagado graceful...');
  
  // Notificar a todos los usuarios
  io.emit('system', {
    type: 'warning',
    message: 'El servidor se reiniciará en 10 segundos',
    timestamp: new Date().toISOString()
  });
  
  // Desconectar todos los sockets después de 5 segundos
  setTimeout(() => {
    io.disconnectSockets();
    
    server.close(() => {
      console.log('✅ Servidor cerrado correctamente');
      process.exit(0);
    });
  }, 5000);
  
  // Timeout forzoso
  setTimeout(() => {
    console.log('⚠️ Apagado forzoso después de timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});

module.exports = { server, storage };