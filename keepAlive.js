// keepAlive.js - Mantiene activo el servidor en Render.com
const fetch = require('node-fetch');

class KeepAlive {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.interval = null;
  }

  start() {
    if (!this.serverUrl) {
      console.warn('⚠️ No se configuró URL para keep-alive');
      return;
    }

    this.interval = setInterval(async () => {
      try {
        const response = await fetch(this.serverUrl, {
          method: 'GET',
          timeout: 10000,
          headers: { 'User-Agent': 'FoxWeb-Chat-KeepAlive/1.0' }
        });
        
        console.log(`✅ Keep-alive ping: ${response.status} - ${new Date().toLocaleTimeString()}`);
      } catch (error) {
        console.log('⚠️ Error en keep-alive:', error.message);
      }
    }, 5 * 60 * 1000); // Cada 5 minutos
    
    console.log('🔄 Servicio keep-alive iniciado');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      console.log('🛑 Servicio keep-alive detenido');
    }
  }
}

module.exports = new KeepAlive();