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
    methods: ["GET", "POST"]
  }
});

// Almacenamiento en memoria (en producción usarías una base de datos)
let users = new Map(); // Map para usuarios conectados
let messages = []; // Array para mensajes (guardados por 24 horas)
let typingUsers = new Map(); // Usuarios escribiendo

// Configuración
const MESSAGE_RETENTION_HOURS = 24; // Mantener mensajes por 24 horas
const MAX_MESSAGES = 1000; // Máximo de mensajes almacenados
const CLEANUP_INTERVAL = 60 * 60 * 1000; // Limpiar cada hora

// Función para limpiar mensajes antiguos
function cleanOldMessages() {
  const now = Date.now();
  const retentionTime = MESSAGE_RETENTION_HOURS * 60 * 60 * 1000;
  
  messages = messages.filter(msg => {
    const messageTime = new Date(msg.timestamp).getTime();
    return (now - messageTime) <= retentionTime;
  });
  
  // Limitar el número total de mensajes
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES);
  }
  
  console.log(`🧹 Mensajes limpiados. Total: ${messages.length}`);
}

// Limpieza periódica
setInterval(cleanOldMessages, CLEANUP_INTERVAL);

// ===== PING AUTOMÁTICO PARA MANTENER ACTIVO =====
let pingInterval;

function startPingService() {
  const serverUrl = 'https://foxweb-chat-server.onrender.com';
  
  pingInterval = setInterval(async () => {
    try {
      const response = await fetch(serverUrl);
      console.log(`✅ Ping automático: ${response.status} - ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.log('⚠️ Error en ping automático:', error.message);
    }
  }, 10 * 60 * 1000);
  
  console.log('🔄 Servicio de ping iniciado');
}

// ===== SOCKET.IO EVENTOS MEJORADOS =====
io.on('connection', (socket) => {
  console.log('Nuevo usuario conectado:', socket.id);
  
  // Enviar cantidad de usuarios
  io.emit('userCount', users.size);
  
  // Enviar historial de mensajes (últimos 50)
  socket.emit('history', {
    messages: messages.slice(-50),
    total: messages.length
  });

  socket.on('join', (userData) => {
    const { username, userId } = userData;
    
    const user = {
      id: socket.id,
      userId: userId || socket.id,
      username: username || `Usuario${socket.id.substring(0, 5)}`,
      joined: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
    
    users.set(socket.id, user);
    
    // Notificar a todos
    io.emit('userJoined', { 
      username: user.username,
      onlineCount: users.size
    });
    
    // Enviar lista actualizada de usuarios
    updateOnlineUsers();
    
    console.log(`${user.username} se unió al chat. Total: ${users.size}`);
  });
  
  socket.on('message', (messageData) => {
    const user = users.get(socket.id);
    if (!user) return;
    
    const message = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      username: user.username,
      userId: user.userId,
      text: messageData.text,
      timestamp: new Date().toISOString(),
      time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    
    // Guardar mensaje
    messages.push(message);
    
    // Limpiar si hay muchos mensajes
    if (messages.length > MAX_MESSAGES) {
      messages = messages.slice(-MAX_MESSAGES);
    }
    
    // Enviar a todos los clientes
    io.emit('message', message);
    
    console.log(`Mensaje de ${user.username}: ${messageData.text.substring(0, 50)}...`);
  });
  
  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (user) {
      typingUsers.set(socket.id, {
        username: user.username,
        timestamp: Date.now()
      });
      
      socket.broadcast.emit('typing', { 
        username: user.username,
        typingUsers: Array.from(typingUsers.values()).map(u => u.username)
      });
      
      // Limpiar después de 3 segundos
      setTimeout(() => {
        if (typingUsers.has(socket.id)) {
          typingUsers.delete(socket.id);
          socket.broadcast.emit('stopTyping', { username: user.username });
        }
      }, 3000);
    }
  });
  
  socket.on('stopTyping', () => {
    const user = users.get(socket.id);
    if (user) {
      typingUsers.delete(socket.id);
      socket.broadcast.emit('stopTyping', { username: user.username });
    }
  });
  
  socket.on('ping', () => {
    socket.emit('pong', { timestamp: Date.now() });
  });
  
  socket.on('requestOnlineUsers', () => {
    const onlineUsers = Array.from(users.values()).map(u => ({
      username: u.username,
      userId: u.userId
    }));
    socket.emit('onlineUsers', onlineUsers);
  });
  
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    
    if (user) {
      users.delete(socket.id);
      typingUsers.delete(socket.id);
      
      io.emit('userLeft', { 
        username: user.username,
        onlineCount: users.size
      });
      
      updateOnlineUsers();
      
      console.log(`${user.username} se desconectó. Quedan: ${users.size}`);
    }
  });
});

// Función para actualizar lista de usuarios en línea
function updateOnlineUsers() {
  const onlineUsers = Array.from(users.values()).map(u => ({
    username: u.username,
    userId: u.userId
  }));
  
  io.emit('onlineUsers', onlineUsers);
}

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({
    status: 'active',
    server: 'FoxWeb Chat Server',
    version: '2.0',
    features: [
      'Chat en tiempo real',
      'Historial de 24 horas',
      'Usuarios en línea',
      'Indicador de escritura',
      'Ping automático'
    ],
    stats: {
      users: users.size,
      messages: messages.length,
      uptime: process.uptime()
    }
  });
});

// Ruta para obtener estadísticas
app.get('/stats', (req, res) => {
  res.json({
    status: 'active',
    users: users.size,
    messages: messages.length,
    messageRetention: `${MESSAGE_RETENTION_HOURS} horas`,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Ruta para obtener mensajes recientes (para debug)
app.get('/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentMessages = messages.slice(-limit);
  
  res.json({
    count: recentMessages.length,
    total: messages.length,
    messages: recentMessages
  });
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de chat FoxWeb v2.0 en puerto ${PORT}`);
  console.log(`📝 Mensajes se guardarán por ${MESSAGE_RETENTION_HOURS} horas`);
  
  // Iniciar ping automático 30 segundos después de iniciar
  setTimeout(startPingService, 30000);
  
  // Ejecutar primera limpieza
  cleanOldMessages();
});

// Manejar cierre del servidor
process.on('SIGINT', () => {
  clearInterval(pingInterval);
  console.log('🛑 Servidor detenido');
  process.exit(0);
});

// Manejar errores no capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Error no capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesa rechazada no manejada:', reason);
});