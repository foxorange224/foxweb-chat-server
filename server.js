const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de chat en puerto ${PORT}`);
});
