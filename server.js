const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// ===== ALMACENAMIENTO OPTIMIZADO =====
class ChatStorage {
  constructor() {
    this.users = new Map(); // socket.id -> userData
    this.userIds = new Map(); // userId -> socket.id (para búsqueda rápida)
    this.messages = []; // Mensajes del chat
    this.typingUsers = new Map(); // username -> timestamp
  }

  // Agregar usuario
  addUser(socketId, userData) {
    const user = {
      socketId,
      userId: userData.userId || socketId,
      username: userData.username || `Usuario${socketId.substring(0, 5)}`,
      joined: Date.now(),
      lastActive: Date.now()
    };
    
    this.users.set(socketId, user);
    this.userIds.set(user.userId, socketId);
    return user;
  }

  // Eliminar usuario
  removeUser(socketId) {
    const user = this.users.get(socketId);
    if (user) {
      this.users.delete(socketId);
      this.userIds.delete(user.userId);
      this.typingUsers.delete(user.username);
    }
    return user;
  }

  // Obtener usuario por socketId
  getUser(socketId) {
    return this.users.get(socketId);
  }

  // Obtener usuario por userId
  getUserByUserId(userId) {
    const socketId = this.userIds.get(userId);
    return socketId ? this.users.get(socketId) : null;
  }

  // Agregar mensaje
  addMessage(message) {
    this.messages.push(message);
    
    // Limitar tamaño manteniendo eficiencia
    if (this.messages.length > MAX_MESSAGES) {
      // Mantener solo los últimos mensajes
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }
    return message;
  }

  // Obtener historial
  getHistory(limit = 50) {
    return this.messages.slice(-limit);
  }

  // Agregar usuario escribiendo
  addTypingUser(username) {
    this.typingUsers.set(username, Date.now());
  }

  // Eliminar usuario escribiendo
  removeTypingUser(username) {
    this.typingUsers.delete(username);
  }

  // Obtener usuarios escribiendo
  getTypingUsers() {
    const now = Date.now();
    const expired = [];
    
    // Limpiar usuarios expirados (más de 10 segundos)
    for (const [username, timestamp] of this.typingUsers) {
      if (now - timestamp > 10000) { // 10 segundos
        expired.push(username);
      }
    }
    
    expired.forEach(username => this.typingUsers.delete(username));
    
    return Array.from(this.typingUsers.keys());
  }

  // Limpiar mensajes antiguos
  cleanOldMessages(retentionHours = 24) {
    const retentionTime = retentionHours * 60 * 60 * 1000;
    const cutoffTime = Date.now() - retentionTime;
    
    this.messages = this.messages.filter(msg => {
      const messageTime = new Date(msg.timestamp).getTime();
      return messageTime >= cutoffTime;
    });
    
    return this.messages.length;
  }

  // Estadísticas
  getStats() {
    return {
      users: this.users.size,
      messages: this.messages.length,
      typingUsers: this.typingUsers.size
    };
  }
}

// ===== CONFIGURACIÓN =====
const MESSAGE_RETENTION_HOURS = 24;
const MAX_MESSAGES = 1000;
const CLEANUP_INTERVAL = 30 * 60 * 1000; // Cada 30 minutos
const PING_INTERVAL = 5 * 60 * 1000; // Cada 5 minutos
const TYPING_TIMEOUT = 5000; // 5 segundos para typing

// Inicializar almacenamiento
const storage = new ChatStorage();

// ===== FUNCIONES AUXILIARES =====
function isValidUsername(username) {
  return username && 
         typeof username === 'string' && 
         username.trim().length >= 2 && 
         username.trim().length <= 20;
}

function sanitizeMessage(text) {
  if (typeof text !== 'string') return '';
  return text.trim().substring(0, 500); // Limitar a 500 caracteres
}

function generateMessageId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// ===== LIMPIEZA PERIÓDICA =====
setInterval(() => {
  try {
    const count = storage.cleanOldMessages(MESSAGE_RETENTION_HOURS);
    console.log(`🧹 Mensajes limpiados. Total: ${count}`);
  } catch (error) {
    console.error('Error en limpieza periódica:', error);
  }
}, CLEANUP_INTERVAL);

// ===== PING AUTOMÁTICO MEJORADO =====
let pingServiceInterval;

function startPingService() {
  const serverUrl = process.env.RENDER_EXTERNAL_URL || 'https://foxweb-chat-server.onrender.com';
  
  if (!serverUrl) {
    console.warn('⚠️ No se configuró URL externa para ping automático');
    return;
  }
  
  pingServiceInterval = setInterval(async () => {
    try {
      const response = await fetch(serverUrl, {
        timeout: 10000,
        headers: { 'User-Agent': 'FoxWeb-Chat-Ping/1.0' }
      });
      
      console.log(`✅ Ping automático: ${response.status} - ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.log('⚠️ Error en ping automático:', error.message);
    }
  }, PING_INTERVAL);
  
  console.log('🔄 Servicio de ping iniciado');
}

// ===== SOCKET.IO EVENTOS OPTIMIZADOS =====
io.on('connection', (socket) => {
  console.log('🔗 Nuevo usuario conectado:', socket.id);
  
  // Enviar estadísticas iniciales
  socket.emit('userCount', storage.users.size);
  
  // Enviar historial de mensajes
  socket.emit('history', {
    messages: storage.getHistory(50),
    total: storage.messages.length
  });

  // Unirse al chat
  socket.on('join', (userData) => {
    try {
      // Validar datos del usuario
      if (!userData || !isValidUsername(userData.username)) {
        socket.emit('error', { message: 'Nombre de usuario inválido' });
        return;
      }
      
      // Registrar usuario
      const user = storage.addUser(socket.id, {
        username: userData.username.trim(),
        userId: userData.userId || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });
      
      // Actualizar última actividad
      user.lastActive = Date.now();
      
      // Notificar a todos
      socket.broadcast.emit('userJoined', {
        username: user.username,
        userId: user.userId,
        onlineCount: storage.users.size
      });
      
      // Enviar usuarios en línea
      updateOnlineUsers();
      
      console.log(`👋 ${user.username} se unió al chat. Total: ${storage.users.size}`);
      
    } catch (error) {
      console.error('Error en evento join:', error);
      socket.emit('error', { message: 'Error al unirse al chat' });
    }
  });
  
  // Recibir mensaje
  socket.on('message', (messageData) => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) {
        socket.emit('error', { message: 'Usuario no autenticado' });
        return;
      }
      
      const text = sanitizeMessage(messageData.text);
      if (!text) {
        socket.emit('error', { message: 'Mensaje vacío' });
        return;
      }
      
      // Crear mensaje
      const message = {
        id: generateMessageId(),
        username: user.username,
        userId: user.userId,
        text: text,
        timestamp: new Date().toISOString(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      // IMPORTANTE: Eliminar usuario de typingUsers cuando envía mensaje
      storage.removeTypingUser(user.username);
      
      // Guardar mensaje
      storage.addMessage(message);
      
      // Actualizar última actividad del usuario
      user.lastActive = Date.now();
      
      // Emitir evento de stopTyping para este usuario
      socket.broadcast.emit('stopTyping', { 
        username: user.username,
        userId: user.userId 
      });
      
      // Enviar mensaje a todos
      io.emit('message', message);
      
      console.log(`💬 Mensaje de ${user.username}: ${text.substring(0, 30)}...`);
      
    } catch (error) {
      console.error('Error en evento message:', error);
      socket.emit('error', { message: 'Error al enviar mensaje' });
    }
  });
  
  // Usuario está escribiendo
  socket.on('typing', () => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) return;
      
      // Agregar/actualizar usuario escribiendo
      storage.addTypingUser(user.username);
      
      // Obtener lista actualizada
      const typingUsersList = storage.getTypingUsers();
      
      // Enviar a todos excepto al usuario actual
      socket.broadcast.emit('typing', {
        username: user.username,
        userId: user.userId,
        typingUsers: typingUsersList
      });
      
      // Configurar timeout para auto-eliminación
      setTimeout(() => {
        if (storage.getTypingUsers().includes(user.username)) {
          storage.removeTypingUser(user.username);
          socket.broadcast.emit('stopTyping', { 
            username: user.username,
            userId: user.userId 
          });
        }
      }, TYPING_TIMEOUT);
      
    } catch (error) {
      console.error('Error en evento typing:', error);
    }
  });
  
  // Usuario dejó de escribir
  socket.on('stopTyping', () => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) return;
      
      storage.removeTypingUser(user.username);
      socket.broadcast.emit('stopTyping', { 
        username: user.username,
        userId: user.userId 
      });
      
    } catch (error) {
      console.error('Error en evento stopTyping:', error);
    }
  });
  
  // Cambio de nombre de usuario
  socket.on('usernameChange', (data) => {
    try {
      const user = storage.getUser(socket.id);
      if (!user) return;
      
      if (!isValidUsername(data.newUsername)) {
        socket.emit('error', { message: 'Nuevo nombre de usuario inválido' });
        return;
      }
      
      const oldUsername = user.username;
      const newUsername = data.newUsername.trim();
      
      // Actualizar username
      user.username = newUsername;
      
      // Actualizar en typingUsers si estaba escribiendo
      if (storage.typingUsers.has(oldUsername)) {
        storage.typingUsers.delete(oldUsername);
        storage.addTypingUser(newUsername);
      }
      
      // Actualizar mensajes existentes
      storage.messages.forEach(msg => {
        if (msg.userId === user.userId) {
          msg.username = newUsername;
        }
      });
      
      // Notificar a todos
      io.emit('usernameChanged', {
        oldUsername: oldUsername,
        newUsername: newUsername,
        userId: user.userId
      });
      
      // Actualizar lista de usuarios en línea
      updateOnlineUsers();
      
      console.log(`📝 ${oldUsername} cambió nombre a ${newUsername}`);
      
    } catch (error) {
      console.error('Error en evento usernameChange:', error);
      socket.emit('error', { message: 'Error al cambiar nombre' });
    }
  });
  
  // Ping
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
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
  
  // Desconexión
  socket.on('disconnect', () => {
    try {
      const user = storage.removeUser(socket.id);
      
      if (user) {
        // Notificar a todos
        io.emit('userLeft', {
          username: user.username,
          userId: user.userId,
          onlineCount: storage.users.size
        });
        
        // Actualizar lista de usuarios
        updateOnlineUsers();
        
        console.log(`👋 ${user.username} se desconectó. Quedan: ${storage.users.size}`);
      }
      
    } catch (error) {
      console.error('Error en desconexión:', error);
    }
  });
  
  // Error de socket
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Función para actualizar usuarios en línea
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

// ===== RUTAS HTTP =====
// Ruta de prueba/estado
app.get('/', (req, res) => {
  const stats = storage.getStats();
  
  res.json({
    status: 'active',
    server: 'FoxWeb Chat Server v3.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    features: [
      'Chat en tiempo real optimizado',
      'Historial inteligente de 24 horas',
      'Indicador de escritura mejorado',
      'Cambio de nombre en tiempo real',
      'Ping automático y limpieza'
    ],
    stats: stats,
    limits: {
      maxMessages: MAX_MESSAGES,
      retentionHours: MESSAGE_RETENTION_HOURS,
      typingTimeout: TYPING_TIMEOUT / 1000 + 's'
    }
  });
});

// Ruta para obtener estadísticas
app.get('/stats', (req, res) => {
  const stats = storage.getStats();
  
  res.json({
    status: 'active',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    ...stats,
    messageRetention: `${MESSAGE_RETENTION_HOURS} horas`,
    cleanupInterval: `${CLEANUP_INTERVAL / 60000} minutos`
  });
});

// Ruta para obtener mensajes (debug/API)
app.get('/messages', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const recentMessages = storage.messages.slice(-limit);
    
    res.json({
      success: true,
      count: recentMessages.length,
      total: storage.messages.length,
      messages: recentMessages
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ruta para limpieza manual
app.post('/cleanup', (req, res) => {
  try {
    const before = storage.messages.length;
    const after = storage.cleanOldMessages(MESSAGE_RETENTION_HOURS);
    
    res.json({
      success: true,
      cleaned: before - after,
      remaining: after,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Ruta health check para Render
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Middleware para errores 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada',
    availableRoutes: ['/', '/stats', '/messages', '/health', '/cleanup']
  });
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor FoxWeb Chat v3.0 iniciado`);
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`💾 Almacenamiento: Memoria (${MAX_MESSAGES} mensajes máx.)`);
  console.log(`⏳ Retención: ${MESSAGE_RETENTION_HOURS} horas`);
  console.log(`✍️  Timeout typing: ${TYPING_TIMEOUT / 1000} segundos`);
  
  // Limpieza inicial
  const remaining = storage.cleanOldMessages(MESSAGE_RETENTION_HOURS);
  console.log(`🧹 Limpieza inicial: ${remaining} mensajes`);
  
  // Iniciar ping automático después de 10 segundos
  setTimeout(startPingService, 10000);
});

// ===== MANEJO DE SEÑALES =====
function gracefulShutdown() {
  console.log('🛑 Iniciando apagado graceful...');
  
  clearInterval(pingServiceInterval);
  
  // Desconectar todos los sockets
  io.disconnectSockets();
  
  // Cerrar servidor
  server.close(() => {
    console.log('✅ Servidor cerrado correctamente');
    process.exit(0);
  });
  
  // Timeout forzoso después de 10 segundos
  setTimeout(() => {
    console.log('⚠️  Apagado forzoso después de timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
  // No salir inmediatamente para mantener el servicio activo
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});