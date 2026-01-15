const http = require('http');

const URL = process.env.APP_URL || 'http://localhost:3000';
const INTERVAL = 5 * 60 * 1000; // 5 minutos

console.log(`🔄 Iniciando keep-alive para: ${URL}`);

function pingServer() {
    const start = Date.now();
    
    http.get(`${URL}/ping`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            const time = Date.now() - start;
            try {
                const json = JSON.parse(data);
                console.log(`✅ Ping exitoso (${time}ms): ${json.onlineUsers} usuarios`);
            } catch {
                console.log(`✅ Ping exitoso (${time}ms)`);
            }
        });
    }).on('error', (err) => {
        console.error(`❌ Error en ping: ${err.message}`);
    });
}

// Ping inicial
pingServer();

// Ping periódico
setInterval(pingServer, INTERVAL);

console.log(`⏰ Ping cada ${INTERVAL/1000/60} minutos`);