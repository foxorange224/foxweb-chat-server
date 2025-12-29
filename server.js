const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch'); // Necesitas instalar esto

const app = express();
app.use(cors({ origin: '*' }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let users = [];

// ===== PING AUTOMÁTICO PARA MANTENER ACTIVO =====
let pingInterval;

function startPingService() {
  // URL de tu propio servidor (cambia por tu URL real)
  const serverUrl = 'https://foxweb-chat-server.onrender.com';
  
  pingInterval = setInterval(async () => {
    try {
      // Hacer ping a sí mismo cada 10 minutos
      const response = await fetch(serverUrl);
      console.log(`✅ Ping automático: ${response.status} - ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      console.log('⚠️ Error en ping automático:', error.message);
    }
  }, 10 * 60 * 1000); // 10 minutos
  
  console.log('🔄 Servicio de ping iniciado');
}

// ===== SOCKET.IO EVENTOS =====
io.on('connection', (socket) => {
  console.log('Nuevo usuario conectado:', socket.id);
  
  // Enviar cantidad de usuarios
  io.emit('userCount', users.length + 1);
  
  socket.on('join', (username) => {
    const user = {
      id: socket.id,
      username: username || `Usuario${socket.id.substring(0, 5)}`,
      joined: new Date().toISOString()
    };
    
    users.push(user);
    
    // Notificar a todos
    io.emit('userJoined', { username: user.username });
    io.emit('userCount', users.length);
    
    console.log(`${user.username} se unió al chat`);
  });
  
  socket.on('message', (message) => {
    const user = users.find(u => u.id === socket.id);
    const username = user ? user.username : 'Anónimo';
    
    io.emit('message', {
      username: username,
      message: message,
      time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    });
    
    console.log(`Mensaje de ${username}: ${message}`);
  });
  
  socket.on('typing', () => {
    const user = users.find(u => u.id === socket.id);
    if (user) {
      socket.broadcast.emit('typing', { username: user.username });
    }
  });
  
  socket.on('stopTyping', () => {
    socket.broadcast.emit('stopTyping');
  });
  
  socket.on('disconnect', () => {
    const userIndex = users.findIndex(u => u.id === socket.id);
    
    if (userIndex !== -1) {
      const disconnectedUser = users[userIndex];
      users.splice(userIndex, 1);
      
      io.emit('userLeft', { username: disconnectedUser.username });
      io.emit('userCount', users.length);
      
      console.log(`${disconnectedUser.username} se desconectó`);
    }
  });
});

// Ruta de prueba
app.get('/', (req, res) => {
  res.send('✅ Servidor de chat FoxWeb funcionando');
});

// Ruta especial para ping (para servicios externos)
app.get('/ping', (req, res) => {
  res.json({
    status: 'active',
    users: users.length,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ===== INICIAR SERVIDOR =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de chat en puerto ${PORT}`);
  
  // Iniciar ping automático 30 segundos después de iniciar
  setTimeout(startPingService, 30000);
});

// Manejar cierre del servidor
process.on('SIGINT', () => {
  clearInterval(pingInterval);
  console.log('🛑 Servidor detenido');
  process.exit(0);
});