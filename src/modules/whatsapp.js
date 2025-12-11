/**
 * Módulo WhatsApp
 * Gerencia o cliente WhatsApp e comandos de mensagens
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

/**
 * Inicializa o módulo WhatsApp
 * @param {Object} config - Configuração do módulo
 * @param {string} config.authDataPath - Caminho para dados de autenticação
 * @param {number} config.port - Porta do servidor (para exibir URL do QR)
 * @param {Object} config.logger - Objeto com funções de log (log, dbg, warn, err)
 * @param {Object} config.camera - Módulo de câmera
 * @param {Object} config.tuya - Módulo Tuya
 * @param {Object} config.utils - Módulo utils
 * @param {string} config.numbersFile - Arquivo com números autorizados
 * @param {string} config.recordDurationSec - Duração padrão de gravação
 * @returns {Object} API do módulo WhatsApp
 */
function initWhatsAppModule({ authDataPath, port, logger, camera, tuya, utils, numbersFile, recordDurationSec }) {
  const { log, dbg, warn, err } = logger;
  const { normalizeBR, toggleNineBR, isNumberAuthorized } = utils;
  
  // Estado interno
  let lastQR = null;
  let isReady = false;
  let tempVideoProcessor = null; // Função para processar vídeos temporários
  let listVideosFunction = null; // Função para listar histórico de vídeos
  let triggerSnapshotFunction = null; // Função para disparar snapshot manualmente
  
  // Cria cliente WhatsApp
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: authDataPath
    }),
    puppeteer: {
      dumpio: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins',
        '--disable-site-isolation-trials',
        '--disable-logging',
        '--log-level=3',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--enable-automation',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-infobars',
        '--disable-notifications',
        '--disable-permissions-api',
        '--disable-blink-features=AutomationControlled'
      ]
    }
  });
  
  // Eventos do cliente
  client.on('loading_screen', (percent, message) => {
    log(`[STATUS] Carregando: ${percent}% - ${message}`);
  });
  
  client.on('qr', qr => {
    lastQR = qr;
    isReady = false;
    log('[QR] QR Code recebido do WhatsApp Web');
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📱 QR CODE PARA AUTENTICAÇÃO');
    console.log('═══════════════════════════════════════════════════════\n');
    qrcodeTerminal.generate(qr, { small: true });
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('💡 Escaneie o QR Code acima com seu WhatsApp');
    console.log(`🌐 Ou acesse: http://localhost:${port}/qr.png`);
    console.log('═══════════════════════════════════════════════════════\n');
    log(`[STATUS] QR Code gerado. Escaneie com seu celular para autenticar. URL: http://localhost:${port}/qr.png`);
  });
  
  client.on('authenticated', () => {
    log('[AUTH] Autenticado com sucesso!');
  });
  
  client.on('ready', () => {
    isReady = true;
    lastQR = null;
    log('[READY] ✅ Cliente conectado e pronto para uso!');
  });
  
  client.on('auth_failure', m => {
    isReady = false;
    err('[AUTH] Falha na autenticação!', m, `Limpe a pasta ${authDataPath} e tente novamente.`);
  });
  
  client.on('disconnected', r => {
    isReady = false;
    warn('[STATUS] Cliente desconectado.', r, 'Tentando reconectar em 5 segundos...');
    setTimeout(() => client.initialize(), 5000);
  });
  
  /**
   * Envia menu principal com botões interativos
   * Nota: whatsapp-web.js pode não suportar botões nativamente, então usamos mensagem de texto formatada
   */
  /**
   * Envia menu principal com botão "Ver opções"
   */
  async function sendMainMenu(chatId) {
    try {
      // Mensagem inicial com botão "Ver opções"
      const welcomeMsg = '🏠 *Menu Principal*\n\n' +
        'Bem-vindo ao sistema de controle inteligente!\n\n' +
        'Para ver as opções disponíveis, clique no botão abaixo ou digite *"ver opções"*:';
      
      // Tenta enviar com botão "Ver opções"
      try {
        const buttons = [
          { body: '👁️ Ver opções', id: 'btn_ver_opcoes' }
        ];
        
        const buttonMessage = {
          text: welcomeMsg,
          buttons: buttons,
          footer: 'WhatsApp API - Controle Inteligente'
        };
        
        await client.sendMessage(chatId, buttonMessage);
        log(`[MENU] Menu principal com botão "Ver opções" enviado para ${chatId}`);
        return;
      } catch (buttonError) {
        dbg(`[MENU] Botão não suportado, usando fallback: ${buttonError.message}`);
        // Continua para o fallback
      }
      
      // Fallback: mensagem de texto com instruções
      const fallbackMsg = welcomeMsg + '\n\n' +
        '💡 *Digite:* `ver opções` ou `menu` para ver todas as opções disponíveis.';
      
      await client.sendMessage(chatId, fallbackMsg);
      log(`[MENU] Menu principal enviado como texto para ${chatId}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu principal:`, e.message);
      // Último fallback: mensagem simples
      try {
        await client.sendMessage(chatId, '🏠 Menu Principal\n\nDigite "ver opções" para ver as opções disponíveis.');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia menu interativo com opções (estilo WhatsApp Business)
   */
  async function sendOptionsMenu(chatId) {
    try {
      // Tenta enviar como List Message (estilo modal do WhatsApp Business)
      try {
        const sections = [{
          title: 'Opções Disponíveis',
          rows: [
            {
              id: 'opt_tuya_list',
              title: '📋 Dispositivos Tuya',
              description: 'Listar e gerenciar seus dispositivos (com status)'
            },
            {
              id: 'opt_tuya_count',
              title: '💡 Luzes Ligadas',
              description: 'Ver quantas luzes estão ligadas (lâmpadas e interruptores)'
            },
            {
              id: 'opt_snapshot',
              title: '📸 Snapshot da Câmera',
              description: 'Tirar foto instantânea da câmera'
            },
            {
              id: 'opt_record',
              title: '🎥 Gravar Vídeo',
              description: 'Gravar vídeo da câmera (padrão: 30 segundos)'
            },
            {
              id: 'opt_videos',
              title: '📹 Histórico de Vídeos',
              description: 'Ver vídeos gravados recentemente (últimas 24h)'
            },
            {
              id: 'opt_help',
              title: '❓ Ajuda',
              description: 'Ver comandos disponíveis e ajuda'
            }
          ]
        }];
        
        const listMessage = {
          title: '🏠 Menu Principal',
          description: 'Selecione uma opção para continuar:',
          buttonText: 'Ver opções',
          sections: sections
        };
        
        await client.sendMessage(chatId, listMessage);
        log(`[MENU] Menu de opções enviado como List Message para ${chatId}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando Reply Buttons: ${listError.message}`);
        // Continua para Reply Buttons
      }
      
      // Fallback: Reply Buttons (botões de resposta rápida)
      try {
        const buttons = [
          { body: '📋 Dispositivos' },
          { body: '💡 Lâmpadas' },
          { body: '📸 Foto' },
          { body: '🎥 Gravar' },
          { body: '📹 Vídeos' },
          { body: '❓ Ajuda' }
        ];
        
        const buttonMessage = {
          text: '🏠 *Menu Principal*\n\n*Selecione uma opção:*\n\n' +
            '📋 *Dispositivos Tuya*\n   Listar dispositivos com status completo\n\n' +
            '💡 *Luzes Ligadas*\n   Ver quantas luzes estão ligadas\n\n' +
            '📸 *Snapshot da Câmera*\n   Tirar foto instantânea\n\n' +
            '🎥 *Gravar Vídeo*\n   Gravar vídeo da câmera\n\n' +
            '📹 *Histórico de Vídeos*\n   Ver vídeos recentes (24h)\n\n' +
            '❓ *Ajuda*\n   Ver comandos disponíveis',
          buttons: buttons,
          footer: 'WhatsApp API - Controle Inteligente'
        };
        
        await client.sendMessage(chatId, buttonMessage);
        log(`[MENU] Menu de opções enviado como Reply Buttons para ${chatId}`);
        return;
      } catch (buttonError) {
        dbg(`[MENU] Reply Buttons não suportado, usando texto: ${buttonError.message}`);
        // Continua para texto
      }
      
      // Fallback final: mensagem de texto formatada
      const textMenu = '🏠 *Menu Principal*\n\n' +
        '📋 *1. Dispositivos Tuya*\n   Clique no botão ou digite: `!tuya list`\n\n' +
        '💡 *2. Luzes Ligadas*\n   Clique no botão ou digite: `!tuya count`\n\n' +
        '📸 *3. Snapshot da Câmera*\n   Clique no botão ou digite: `!snapshot`\n\n' +
        '🎥 *4. Gravar Vídeo*\n   Clique no botão ou digite: `!record`\n\n' +
        '📹 *5. Histórico de Vídeos*\n   Clique no botão ou digite: `!videos`\n\n' +
        '❓ *6. Ajuda*\n   Clique no botão ou digite: `!tuya help`\n\n' +
        '💡 *Dica:* Clique nos botões acima para interagir sem digitar!';
      
      await client.sendMessage(chatId, textMenu);
      log(`[MENU] Menu de opções enviado como texto para ${chatId}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de opções:`, e.message);
      // Último fallback
      try {
        await client.sendMessage(chatId, '🏠 Menu Principal\n\nDigite:\n- !tuya list\n- !tuya status <nome>\n- !record\n- !tuya help');
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Envia lista de dispositivos Tuya
   * Nota: whatsapp-web.js pode não suportar List Messages nativamente, então usamos mensagem de texto formatada
   */
  async function sendDevicesList(chatId, devices, page = 0) {
    try {
      if (!devices || devices.length === 0) {
        await client.sendMessage(chatId, '❌ Nenhum dispositivo encontrado.');
        return;
      }
      
      // Ordena dispositivos: online primeiro, depois offline
      const sortedDevices = [...devices].sort((a, b) => {
        const aOnline = a.online ? 1 : 0;
        const bOnline = b.online ? 1 : 0;
        // Online primeiro (ordem decrescente: 1 antes de 0)
        if (bOnline !== aOnline) {
          return bOnline - aOnline;
        }
        // Se ambos têm o mesmo status, ordena por nome
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        return aName.localeCompare(bName);
      });
      
      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.ceil(sortedDevices.length / ITEMS_PER_PAGE);
      const startIndex = page * ITEMS_PER_PAGE;
      const endIndex = startIndex + ITEMS_PER_PAGE;
      const pageDevices = sortedDevices.slice(startIndex, endIndex);
      const hasMore = endIndex < sortedDevices.length;
      
      // Tenta enviar como List Message (pode não funcionar)
      try {
        const sections = [{
          title: hasMore ? `Dispositivos (Página ${page + 1}/${totalPages})` : 'Dispositivos Disponíveis',
          rows: pageDevices.map((device, index) => {
            const status = device.online ? '🟢' : '🔴';
            const powered = device.poweredOn ? '⚡' : '⚫';
            const onlineStatus = device.online ? 'Online' : 'Offline';
            return {
              id: `device_${device.id}`,
              title: `${status} ${device.name || `Dispositivo ${startIndex + index + 1}`}`,
              description: `${powered} ${onlineStatus} | ${device.category || 'Sem categoria'}`
            };
          })
        }];
        
        // Adiciona opção "Ver Mais" se houver mais páginas
        if (hasMore) {
          sections[0].rows.push({
            id: `devices_page_${page + 1}`,
            title: '📄 Ver Próxima Página',
            description: `Mostrar mais ${Math.min(ITEMS_PER_PAGE, sortedDevices.length - endIndex)} dispositivo(s)`
          });
        }
        
        const listMessage = {
          title: '📋 Dispositivos Tuya',
          description: `Selecione um dispositivo (${startIndex + 1}-${Math.min(endIndex, sortedDevices.length)} de ${sortedDevices.length}):`,
          buttonText: 'Ver Dispositivos',
          sections: sections
        };
        
        await client.sendMessage(chatId, listMessage);
        log(`[MENU] Lista de ${pageDevices.length} dispositivo(s) (página ${page + 1}/${totalPages}) enviada como List Message para ${chatId}`);
        return;
      } catch (listError) {
        dbg(`[MENU] List Message não suportado, usando fallback de texto: ${listError.message}`);
        // Continua para o fallback
      }
      
      // Fallback: mensagem de texto formatada (sempre funciona)
      let textList = `📋 *Dispositivos Tuya*\n\n`;
      textList += `*Total:* ${sortedDevices.length} dispositivo(s)\n`;
      textList += `*Página:* ${page + 1}/${totalPages}\n\n`;
      textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Agrupa por status
      const onlineDevices = pageDevices.filter(d => d.online);
      const offlineDevices = pageDevices.filter(d => !d.online);
      
      if (onlineDevices.length > 0) {
        textList += `🟢 *ONLINE (${onlineDevices.length})*\n\n`;
        onlineDevices.forEach((device, index) => {
          const powered = device.poweredOn ? '⚡ Ligado' : '⚫ Desligado';
          textList += `${startIndex + index + 1}. ${device.name || `Dispositivo ${startIndex + index + 1}`}\n`;
          textList += `   ${powered} | ${device.category || 'Sem categoria'}\n`;
          textList += `   ID: \`device_${device.id}\`\n\n`;
        });
      }
      
      if (offlineDevices.length > 0) {
        if (onlineDevices.length > 0) {
          textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        }
        textList += `🔴 *OFFLINE (${offlineDevices.length})*\n\n`;
        offlineDevices.forEach((device, index) => {
          const powered = device.poweredOn ? '⚡ Ligado' : '⚫ Desligado';
          textList += `${startIndex + onlineDevices.length + index + 1}. ${device.name || `Dispositivo ${startIndex + onlineDevices.length + index + 1}`}\n`;
          textList += `   ${powered} | ${device.category || 'Sem categoria'}\n`;
          textList += `   ID: \`device_${device.id}\`\n\n`;
        });
      }
      
      if (hasMore) {
        textList += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        textList += `📄 *Mais ${Math.min(ITEMS_PER_PAGE, sortedDevices.length - endIndex)} dispositivo(s) disponível(is)*\n`;
        textList += `💡 Digite \`!tuya list page ${page + 1}\` para ver a próxima página`;
      }
      
      await client.sendMessage(chatId, textList);
      log(`[MENU] Lista de ${pageDevices.length} dispositivo(s) (página ${page + 1}/${totalPages}) enviada como texto para ${chatId}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar lista de dispositivos:`, e.message);
      // Último fallback
      try {
        await client.sendMessage(chatId, `❌ Erro ao listar dispositivos: ${e.message}`);
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Processa gravação de vídeo RTSP
   */
  async function processVideoRecording(chatId, duration = 30) {
    // Para processVideoRecording, chatId já é o ID do chat, não precisamos extrair
    const fromNumber = chatId.split('@')[0];
    
    if (!isNumberAuthorized(fromNumber, numbersFile, dbg)) {
      await client.sendMessage(chatId, '❌ Você não está autorizado a usar este comando.');
      return;
    }
    
    const rtspUrl = camera.buildRTSPUrl();
    if (!rtspUrl) {
      await client.sendMessage(chatId, '❌ Gravação não configurada. Configure CAMERA_RTSP_URL ou CAMERA_USER/CAMERA_PASS.');
      return;
    }
    
    const finalDuration = Math.min(Math.max(5, duration), 120);
    
    if (duration > 120) {
      await client.sendMessage(chatId, `⚠️ Duração limitada a 120 segundos (solicitado: ${duration}s)`);
    }
    
    log(`[CMD] Iniciando gravação de ${finalDuration} segundos para ${chatId}`);
    
    // Cria uma mensagem fake para reutilizar a lógica existente
    const fakeMessage = {
      from: chatId,
      reply: async (text) => {
        await client.sendMessage(chatId, text);
      }
    };
    
    // Processa gravação em background
    (async () => {
      try {
        const result = await camera.recordRTSPVideo(rtspUrl, finalDuration, fakeMessage);
        
        if (result.success && result.filePath && fs.existsSync(result.filePath)) {
          const originalFilePath = result.filePath;
          const fileStats = fs.statSync(originalFilePath);
          log(`[RECORD] Arquivo gerado: ${originalFilePath} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
          
          const finalVideoPath = await camera.compressVideoIfNeeded(originalFilePath, fakeMessage);
          const finalStats = fs.statSync(finalVideoPath);
          log(`[RECORD] Arquivo final para envio: ${finalVideoPath} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`);
          
          const videoBuffer = fs.readFileSync(finalVideoPath);
          
          if (videoBuffer.length === 0) {
            throw new Error('Vídeo está vazio ou corrompido');
          }
          
          const sizeMB = videoBuffer.length / 1024 / 1024;
          if (sizeMB > 16) {
            throw new Error(`Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB`);
          }
          
          const videoBase64 = videoBuffer.toString('base64');
          const fileName = `video_${Date.now()}.mp4`;
          const videoMedia = new MessageMedia('video/mp4', videoBase64, fileName);
          const caption = `🎥 Gravação de ${finalDuration} segundos`;
          
          try {
            const sendResult = await client.sendMessage(chatId, videoMedia, { caption });
            log(`[CMD] Vídeo enviado com sucesso como VÍDEO | id=${sendResult.id?._serialized || 'n/a'}`);
            
            camera.cleanupVideoFile(finalVideoPath, 'após envio bem-sucedido (como vídeo)');
            if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
              camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
            }
          } catch (sendError) {
            err(`[CMD] Erro ao enviar vídeo como VÍDEO:`, sendError.message);
            await client.sendMessage(chatId, `❌ Erro ao enviar vídeo: ${sendError.message}`);
            camera.cleanupVideoFile(finalVideoPath, 'após erro no envio');
            if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
              camera.cleanupVideoFile(originalFilePath, 'após erro (original)');
            }
          }
        } else {
          const failMsg = `❌ Falha na gravação: ${result.error || 'Erro desconhecido'}`;
          await client.sendMessage(chatId, failMsg);
          
          if (result.filePath && fs.existsSync(result.filePath)) {
            camera.cleanupVideoFile(result.filePath, 'após falha na gravação');
          }
        }
      } catch (e) {
        err(`[CMD] Erro ao processar gravação:`, e.message);
        await client.sendMessage(chatId, `❌ Erro ao processar gravação: ${e.message}`);
      }
    })();
  }
  
  /**
   * Envia menu de ações para um dispositivo específico
   * Nota: whatsapp-web.js pode não suportar botões nativamente, então usamos mensagem de texto formatada
   */
  async function sendDeviceActionsMenu(chatId, device) {
    try {
      // Tenta enviar como botões (pode não funcionar)
      try {
        const buttons = [
          { body: '🟢 Ligar', id: `action_on_${device.id}` },
          { body: '🔴 Desligar', id: `action_off_${device.id}` },
          { body: '🔄 Alternar', id: `action_toggle_${device.id}` },
          { body: '📊 Status', id: `action_status_${device.id}` }
        ];
        
        const buttonMessage = {
          text: `⚙️ *${device.name || 'Dispositivo'}*\n\nSelecione uma ação:`,
          buttons: buttons,
          footer: `ID: ${device.id.substring(0, 20)}...`
        };
        
        await client.sendMessage(chatId, buttonMessage);
        log(`[MENU] Menu de ações enviado como botões para dispositivo ${device.id}`);
        return;
      } catch (buttonError) {
        dbg(`[MENU] Botões não suportados, usando fallback de texto: ${buttonError.message}`);
        // Continua para o fallback
      }
      
      // Fallback: mensagem de texto formatada (sempre funciona)
      const deviceIdentifier = device.name || device.id.substring(0, 20);
      const fallbackMsg = `⚙️ *${device.name || 'Dispositivo'}*\n\n` +
        `*Ações disponíveis:*\n\n` +
        `🟢 *Ligar*\n   Digite: \`!tuya on ${deviceIdentifier}\`\n\n` +
        `🔴 *Desligar*\n   Digite: \`!tuya off ${deviceIdentifier}\`\n\n` +
        `🔄 *Alternar*\n   Digite: \`!tuya toggle ${deviceIdentifier}\`\n\n` +
        `📊 *Status*\n   Digite: \`!tuya status ${deviceIdentifier}\`\n\n` +
        `💡 *Dica:* Você também pode usar o número do dispositivo (ex: \`!tuya on 1\`)`;
      
      await client.sendMessage(chatId, fallbackMsg);
      log(`[MENU] Menu de ações enviado como texto para dispositivo ${device.id}`);
    } catch (e) {
      err(`[MENU] Erro ao enviar menu de ações:`, e.message);
      // Último fallback
      try {
        const deviceIdentifier = device.name || device.id.substring(0, 20);
        await client.sendMessage(chatId, `⚙️ ${device.name || 'Dispositivo'}\n\nDigite:\n- !tuya on ${deviceIdentifier}\n- !tuya off ${deviceIdentifier}\n- !tuya toggle ${deviceIdentifier}\n- !tuya status ${deviceIdentifier}`);
      } catch (e2) {
        err(`[MENU] Erro no fallback final:`, e2.message);
      }
    }
  }
  
  /**
   * Extrai o número do remetente da mensagem
   * Comportamento similar ao script antigo: usa message.from diretamente
   */
  function getSenderNumber(message) {
    // Se a mensagem é de mim mesmo, não processa
    if (message.fromMe) {
      return null;
    }
    
    // Comportamento simples: usa message.from diretamente (como no script antigo)
    // Se for conversa direta (@c.us), já vem o número correto
    // Se for lista de transmissão (@lid), vem o ID da lista (que precisa estar no numbers.txt)
    const fromNumber = message.from.split('@')[0];
    
    dbg(`[GET-SENDER] message.from: ${message.from} -> número extraído: ${fromNumber}`);
    
    return fromNumber;
  }
  
  /**
   * Processa interações de botões e listas
   * Nota: whatsapp-web.js pode não suportar nativamente botões/listas da API Business.
   * Esta implementação tenta detectar mensagens que correspondem a IDs de botões/listas.
   */
  client.on('message', async (message) => {
    if (message.isStatus) return;
    
    const msgBody = (message.body || '').trim();
    const msgLower = msgBody.toLowerCase();
    
    // Extrai número do remetente (comportamento simples como no script antigo)
    const senderNumber = getSenderNumber(message);
    
    if (!senderNumber) {
      dbg(`[MSG-DEBUG] Mensagem é de mim mesmo ou número não pôde ser extraído. Ignorando.`);
      return;
    }
    
    const isAuthorized = isNumberAuthorized(senderNumber, numbersFile, dbg);
    
    dbg(`[MSG-DEBUG] message.from: ${message.from}, senderNumber: ${senderNumber}, autorizado: ${isAuthorized}`);
    
    if (isAuthorized) {
      // Processa botão "Ver opções" ou comando "ver opções"
      if (msgBody === 'btn_ver_opcoes' || msgLower === 'ver opções' || msgLower === 'ver opcoes' || msgLower === 'ver opção' || msgLower === 'ver opcao') {
        log(`[MENU] Botão "Ver opções" detectado de ${message.from}`);
        try {
          await sendOptionsMenu(message.from);
        } catch (e) {
          err(`[MENU] Erro ao processar "ver opções":`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      // Processa seleções do menu de opções
      if (msgBody === 'opt_tuya_list' || msgLower.includes('dispositivos tuya') || msgLower === 'dispositivos' || msgLower === '📋 dispositivos') {
        log(`[MENU] Opção "Dispositivos Tuya" selecionada de ${message.from}`);
        try {
          await message.reply('⏳ Buscando seus dispositivos...');
          const devices = await tuya.getCachedDevices();
          await sendDevicesList(message.from, devices, 0);
        } catch (e) {
          err(`[MENU] Erro ao processar opt_tuya_list:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      // Processa paginação de dispositivos (devices_page_*)
      if (msgBody.startsWith('devices_page_')) {
        const pageStr = msgBody.replace('devices_page_', '');
        const page = parseInt(pageStr, 10);
        
        if (isNaN(page) || page < 0) {
          await message.reply('❌ Página inválida.');
          return;
        }
        
        log(`[MENU] Página ${page} de dispositivos solicitada de ${message.from}`);
        try {
          const devices = await tuya.getCachedDevices();
          await sendDevicesList(message.from, devices, page);
        } catch (e) {
          err(`[MENU] Erro ao processar devices_page_${page}:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      
      if (msgBody === 'opt_snapshot' || msgLower === '!snapshot' || msgLower === '!foto' || msgLower === '!photo') {
        log(`[MENU] Opção "Snapshot" selecionada de ${message.from}`);
        try {
          if (triggerSnapshotFunction) {
            await message.reply('⏳ Tirando foto da câmera...');
            const result = await triggerSnapshotFunction('📸 Snapshot solicitado manualmente', message.from);
            if (result && result.ok) {
              await message.reply(`✅ Foto enviada com sucesso para ${result.successCount || 0} número(s)!`);
            } else {
              await message.reply(`❌ Erro ao tirar foto: ${result?.error || 'Erro desconhecido'}`);
            }
          } else {
            await message.reply('❌ Função de snapshot não disponível. Configure a câmera.');
          }
        } catch (e) {
          err(`[MENU] Erro ao processar opt_snapshot:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      if (msgBody === 'opt_videos' || msgLower === '!videos' || msgLower === '!historico' || msgLower === '!histórico' || msgLower === '!hist') {
        log(`[MENU] Opção "Histórico de Vídeos" selecionada de ${message.from}`);
        try {
          if (listVideosFunction) {
            const videos = listVideosFunction(message.from);
            const fs = require('fs');
            
            if (videos.length === 0) {
              await message.reply('📹 *Histórico de Vídeos*\n\nNenhum vídeo disponível no momento.\n\n💡 Vídeos são gravados automaticamente quando a campainha é tocada.');
            } else {
              const displayVideos = videos.slice(0, 10);
              const remainingCount = videos.length - displayVideos.length;
              
              let msg = `📹 *Histórico de Vídeos*\n\n`;
              msg += `📊 *Total:* ${videos.length} vídeo(s) disponível(is)\n`;
              msg += `⏰ *Válidos por:* 24 horas após gravação\n\n`;
              msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
              
              displayVideos.forEach((video, index) => {
                const date = new Date(video.createdAt);
                const dateStr = date.toLocaleString('pt-BR', { 
                  day: '2-digit', 
                  month: '2-digit', 
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                });
                
                const now = Date.now();
                const expiresAt = video.expiresAt || (video.createdAt + (24 * 60 * 60 * 1000));
                const timeRemaining = expiresAt - now;
                const hoursRemaining = Math.floor(timeRemaining / (60 * 60 * 1000));
                const minutesRemaining = Math.floor((timeRemaining % (60 * 60 * 1000)) / (60 * 1000));
                
                let fileSize = 'N/A';
                if (video.fileExists && video.filePath) {
                  try {
                    const stats = fs.statSync(video.filePath);
                    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                    fileSize = `${sizeMB} MB`;
                  } catch (e) {
                    fileSize = 'Erro';
                  }
                }
                
                const status = video.fileExists ? '✅' : '❌';
                const timeStatus = timeRemaining > 0 ? `⏳ ${hoursRemaining}h ${minutesRemaining}min` : '⏰ Expirado';
                
                msg += `${index + 1}. ${status} *${dateStr}*\n`;
                msg += `   📁 Tamanho: ${fileSize}\n`;
                msg += `   ${timeStatus} restante\n`;
                msg += `   🆔 ID: \`${video.videoId.substring(0, 20)}...\`\n`;
                msg += `   👁️ Ver: \`!video ${video.videoId}\`\n\n`;
              });
              
              if (remainingCount > 0) {
                msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
                msg += `📋 *E mais ${remainingCount} vídeo(s) disponível(is)*\n`;
              }
              
              msg += `\n💡 *Como usar:*\n`;
              msg += `• Digite \`!video <ID>\` para ver um vídeo\n`;
              msg += `• Ou clique no botão "Ver Vídeo" quando receber a notificação\n`;
              msg += `• Vídeos expiram automaticamente após 24 horas`;
              
              await message.reply(msg);
            }
          } else {
            await message.reply('❌ Sistema de histórico não disponível.');
          }
        } catch (e) {
          err(`[MENU] Erro ao processar opt_videos:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      if (msgBody === 'opt_record' || msgLower.includes('gravar vídeo') || msgLower.includes('gravar video') || msgLower === 'gravar' || msgLower === '🎥 gravar') {
        log(`[MENU] Opção "Gravar Vídeo" selecionada de ${message.from}`);
        try {
          await message.reply('⏳ Iniciando gravação de 30 segundos...');
          await processVideoRecording(message.from, 30);
        } catch (e) {
          err(`[MENU] Erro ao processar opt_record:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      if (msgBody === 'opt_help' || msgLower.includes('ajuda') || msgLower === 'help' || msgLower === '❓ ajuda') {
        log(`[MENU] Opção "Ajuda" selecionada de ${message.from}`);
        if (tuya && tuya.formatHelpMessage) {
          const helpMsg = tuya.formatHelpMessage();
          await message.reply(helpMsg);
        }
        return;
      }
      
      // Processa respostas de botões do menu principal (compatibilidade com versões antigas)
      if (msgBody === 'menu_tuya_list' || msgLower.includes('listar dispositivos')) {
        log(`[MENU] Botão "Listar Dispositivos" detectado de ${message.from}`);
        try {
          await message.reply('⏳ Buscando seus dispositivos...');
          const devices = await tuya.getCachedDevices();
          await sendDevicesList(message.from, devices);
        } catch (e) {
          err(`[MENU] Erro ao processar menu_tuya_list:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      if (msgBody === 'menu_record' || msgLower.includes('gravar vídeo') || msgLower.includes('gravar video')) {
        log(`[MENU] Botão "Gravar Vídeo" detectado de ${message.from}`);
        try {
          await message.reply('⏳ Iniciando gravação de 30 segundos...');
          await processVideoRecording(message.from, 30);
        } catch (e) {
          err(`[MENU] Erro ao processar menu_record:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      if (msgBody === 'menu_help' || msgLower.includes('ajuda') || msgLower.includes('help')) {
        log(`[MENU] Botão "Ajuda" detectado de ${message.from}`);
        if (tuya && tuya.formatHelpMessage) {
          const helpMsg = tuya.formatHelpMessage();
          await message.reply(helpMsg);
        }
        return;
      }
      
      // Processa ações de dispositivo (action_on_*, action_off_*, etc.)
      if (msgBody.startsWith('action_')) {
        const parts = msgBody.split('_');
        if (parts.length >= 3) {
          const action = parts[1]; // on, off, toggle, status
          const deviceId = parts.slice(2).join('_'); // device ID pode ter underscores
          
          log(`[MENU] Ação de dispositivo detectada: ${action} para ${deviceId} por ${message.from}`);
          
          try {
            const devices = await tuya.getCachedDevices();
            const device = devices.find(d => d.id === deviceId);
            
            if (!device) {
              await message.reply(`❌ Dispositivo não encontrado.`);
              return;
            }
            
            if (action === 'on') {
              await message.reply('⏳ Ligando dispositivo...');
              const status = await tuya.getDeviceStatus(device.id);
              const switchCode = tuya.findSwitchCode(status);
              if (switchCode) {
                await tuya.sendCommand(device.id, [{ code: switchCode, value: true }]);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await message.reply(`✅ *Dispositivo ligado!*\n\n*Nome:* ${device.name}`);
              } else {
                await message.reply('❌ Não foi possível encontrar o código de switch.');
              }
            } else if (action === 'off') {
              await message.reply('⏳ Desligando dispositivo...');
              const status = await tuya.getDeviceStatus(device.id);
              const switchCode = tuya.findSwitchCode(status);
              if (switchCode) {
                await tuya.sendCommand(device.id, [{ code: switchCode, value: false }]);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await message.reply(`✅ *Dispositivo desligado!*\n\n*Nome:* ${device.name}`);
              } else {
                await message.reply('❌ Não foi possível encontrar o código de switch.');
              }
            } else if (action === 'toggle') {
              await message.reply('⏳ Alternando estado...');
              const status = await tuya.getDeviceStatus(device.id);
              const switchCode = tuya.findSwitchCode(status);
              if (switchCode) {
                const currentSwitch = status.find(s => s.code?.toLowerCase() === switchCode.toLowerCase());
                const currentValue = currentSwitch?.value;
                const isOn = currentValue === true || currentValue === 1 || currentValue === 'true' || currentValue === 'on';
                await tuya.sendCommand(device.id, [{ code: switchCode, value: !isOn }]);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await message.reply(`✅ *Estado alternado!*\n\n*Nome:* ${device.name}`);
              } else {
                await message.reply('❌ Não foi possível encontrar o código de switch.');
              }
            } else if (action === 'status') {
              await message.reply('⏳ Consultando status...');
              const status = await tuya.getDeviceStatus(device.id);
              const poweredOn = status.filter(s => {
                const code = s.code?.toLowerCase() || '';
                const value = s.value;
                if (code.includes('switch') || code.includes('power')) {
                  return value === true || value === 1 || value === 'true' || value === 'on';
                }
                return false;
              }).length > 0;
              const responseMsg = tuya.formatDeviceStatusMessage(device.name, status, poweredOn);
              await message.reply(responseMsg);
            }
          } catch (e) {
            err(`[MENU] Erro ao processar ação ${action}:`, e.message);
            await message.reply(`❌ Erro: ${e.message}`);
          }
          return;
        }
      }
      
      // Processa seleção de dispositivo da lista (device_*) - mostra status completo com ações
      if (msgBody.startsWith('device_')) {
        const deviceId = msgBody.replace('device_', '');
        log(`[MENU] Dispositivo selecionado da lista: ${deviceId} por ${message.from}`);
        
        try {
          const devices = await tuya.getCachedDevices();
          const device = devices.find(d => d.id === deviceId);
          
          if (device) {
            await message.reply('⏳ Consultando status do dispositivo...');
            const status = await tuya.getDeviceStatus(device.id);
            const poweredOn = status.filter(s => {
              const code = s.code?.toLowerCase() || '';
              const value = s.value;
              if (code.includes('switch') || code.includes('power')) {
                return value === true || value === 1 || value === 'true' || value === 'on';
              }
              return false;
            }).length > 0;
            
            const responseMsg = tuya.formatDeviceStatusMessage(device.name, status, poweredOn);
            
            // Envia status com botões de ação
            try {
              const buttons = [
                { body: '⚡ Ligar', id: `action_on_${device.id}` },
                { body: '⚫ Desligar', id: `action_off_${device.id}` },
                { body: '🔄 Alternar', id: `action_toggle_${device.id}` },
                { body: '📋 Voltar', id: 'opt_tuya_list' }
              ];
              
              const buttonMessage = {
                text: responseMsg,
                buttons: buttons,
                footer: `Dispositivo: ${device.name}`
              };
              
              await client.sendMessage(message.from, buttonMessage);
              log(`[MENU] Status do dispositivo ${device.name} enviado com botões de ação para ${message.from}`);
            } catch (buttonError) {
              // Se botões não funcionarem, envia apenas o texto
              await message.reply(responseMsg);
              await message.reply(`\n💡 *Ações disponíveis:*\n• Ligar: \`!tuya on ${device.name}\`\n• Desligar: \`!tuya off ${device.name}\`\n• Alternar: \`!tuya toggle ${device.name}\``);
            }
          } else {
            await message.reply('❌ Dispositivo não encontrado.');
            // Oferece lista de dispositivos
            const devices = await tuya.getCachedDevices();
            if (devices && devices.length > 0) {
              await sendDevicesList(message.from, devices, 0);
            }
          }
        } catch (e) {
          err(`[MENU] Erro ao processar seleção de dispositivo:`, e.message);
          await message.reply(`❌ Erro: ${e.message}`);
        }
        return;
      }
      
      // Processa botão "Ver Vídeo" (view_video_*)
      if (msgBody.startsWith('view_video_')) {
        const videoId = msgBody.replace('view_video_', '');
        log(`[MENU] Solicitação de vídeo: ${videoId} por ${message.from}`);
        
        if (!tempVideoProcessor) {
          await message.reply('❌ Sistema de vídeos temporários não disponível.');
          return;
        }
        
        try {
          const senderNumber = getSenderNumber(message);
          if (!senderNumber) {
            await message.reply('❌ Não foi possível identificar seu número.');
            return;
          }
          
          log(`[MENU] Processando vídeo ${videoId} para ${senderNumber}`);
          
          const result = tempVideoProcessor(videoId, senderNumber);
          
          if (!result.success) {
            err(`[MENU] Erro ao processar vídeo ${videoId}: ${result.error}`);
            await message.reply(`❌ ${result.error || 'Erro ao processar vídeo'}`);
            return;
          }
          
          log(`[MENU] Vídeo ${videoId} autorizado, arquivo: ${result.filePath}`);
          
          const fs = require('fs');
          if (!fs.existsSync(result.filePath)) {
            await message.reply('❌ Arquivo de vídeo não encontrado.');
            return;
          }
          
          const videoBuffer = fs.readFileSync(result.filePath);
          const videoBase64 = videoBuffer.toString('base64');
          const sizeMB = videoBuffer.length / 1024 / 1024;
          
          if (sizeMB > 16) {
            await message.reply(`❌ Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB.`);
            return;
          }
          
          const { MessageMedia } = require('whatsapp-web.js');
          const videoMedia = new MessageMedia('video/mp4', videoBase64, `video_${videoId}.mp4`);
          
          await message.reply('⏳ Enviando vídeo...');
          await client.sendMessage(message.from, videoMedia, { caption: '🎥 Vídeo da campainha (15 segundos)' });
          log(`[MENU] Vídeo ${videoId} enviado com sucesso para ${message.from}`);
        } catch (e) {
          err(`[MENU] Erro ao enviar vídeo:`, e.message);
          await message.reply(`❌ Erro ao enviar vídeo: ${e.message}`);
        }
        return;
      }
      
      // Processa botão "Pular" (skip_video)
      if (msgBody === 'skip_video') {
        log(`[MENU] Usuário optou por pular o vídeo: ${message.from}`);
        // Não precisa fazer nada, apenas logar
        return;
      }
    }
    
    log(`[MSG] Mensagem recebida de ${message.from}: "${message.body}"`);
    
    // Comando !menu - Exibe menu principal
    if (msgLower === '!menu' || msgLower === 'menu' || msgLower === 'início' || msgLower === 'inicio') {
      log(`[CMD] Comando !menu recebido de ${message.from}`);
      try {
        await sendMainMenu(message.from);
        log(`[CMD] Menu principal enviado para ${message.from}`);
      } catch (e) {
        err(`[CMD] Falha ao enviar menu:`, e.message);
      }
      return;
    }
    
    // Responde a saudações com menu principal
    const greetings = ['oi', 'olá', 'ola', 'hey', 'hi', 'hello', 'bom dia', 'boa tarde', 'boa noite', 'start', 'começar', 'comecar'];
    if (greetings.includes(msgLower)) {
      const senderNumber = getSenderNumber(message);
      if (!senderNumber) return;
      const isAuthorized = isNumberAuthorized(senderNumber, numbersFile, dbg);
      
      if (isAuthorized) {
        log(`[CMD] Saudação recebida de ${message.from}, enviando menu principal`);
        try {
          await sendMainMenu(message.from);
        } catch (e) {
          err(`[CMD] Falha ao enviar menu após saudação:`, e.message);
        }
      }
      return;
    }
    
    // Comando !snapshot ou !foto
    if (msgLower === '!snapshot' || msgLower === '!foto' || msgLower === '!photo') {
      log(`[CMD] Comando de snapshot recebido de ${message.from}`);
      try {
        if (triggerSnapshotFunction) {
          await message.reply('⏳ Tirando foto da câmera...');
          const result = await triggerSnapshotFunction('📸 Snapshot solicitado manualmente', message.from);
          if (result && result.ok) {
            await message.reply(`✅ Foto enviada com sucesso para ${result.successCount || 0} número(s)!`);
          } else {
            await message.reply(`❌ Erro ao tirar foto: ${result?.error || 'Erro desconhecido'}`);
          }
        } else {
          await message.reply('❌ Função de snapshot não disponível. Configure a câmera.');
        }
      } catch (e) {
        err(`[CMD] Erro ao processar snapshot:`, e.message);
        await message.reply(`❌ Erro: ${e.message}`);
      }
      return;
    }
    
    // Comando !ping
    if (msgLower === '!ping') {
      log(`[CMD] Comando !ping recebido de ${message.from}. Respondendo...`);
      try {
        await message.reply('pong');
        log(`[CMD] Resposta 'pong' enviada para ${message.from}.`);
      } catch (e) {
        err(`[CMD] Falha ao responder 'pong' para ${message.from}:`, e.message);
      }
      return;
    }
    
    // Comando !video <videoId> - Solicita vídeo temporário
    const videoMatch = message.body.match(/^!video\s+(.+)$/i);
    if (videoMatch) {
      const videoId = videoMatch[1].trim();
      const fromNumber = getSenderNumber(message);
      if (!fromNumber) return;
      log(`[CMD] Comando !video recebido de ${message.from} para videoId: ${videoId}`);
      
      if (!tempVideoProcessor) {
        await message.reply('❌ Sistema de vídeos temporários não disponível.');
        return;
      }
      
      try {
        const result = tempVideoProcessor(videoId, fromNumber);
        
        if (!result.success) {
          await message.reply(`❌ ${result.error || 'Erro ao processar vídeo'}`);
          return;
        }
        
        const fs = require('fs');
        if (!fs.existsSync(result.filePath)) {
          await message.reply('❌ Arquivo de vídeo não encontrado.');
          return;
        }
        
        const videoBuffer = fs.readFileSync(result.filePath);
        const videoBase64 = videoBuffer.toString('base64');
        const sizeMB = videoBuffer.length / 1024 / 1024;
        
        if (sizeMB > 16) {
          await message.reply(`❌ Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB.`);
          return;
        }
        
        const { MessageMedia } = require('whatsapp-web.js');
        const videoMedia = new MessageMedia('video/mp4', videoBase64, `video_${videoId}.mp4`);
        
        await message.reply('⏳ Enviando vídeo...');
        await client.sendMessage(message.from, videoMedia, { caption: '🎥 Vídeo da campainha (15 segundos)' });
        log(`[CMD] Vídeo ${videoId} enviado via comando !video para ${message.from}`);
      } catch (e) {
        err(`[CMD] Erro ao enviar vídeo via comando:`, e.message);
        await message.reply(`❌ Erro ao enviar vídeo: ${e.message}`);
      }
      return;
    }
    
    // Comando !record - Grava vídeo RTSP
    const recordMatch = message.body.match(/^!record(?:\s+(\d+))?$/i);
    if (recordMatch) {
      const fromNumber = getSenderNumber(message);
      if (!fromNumber) return;
      log(`[CMD] Comando !record recebido de ${message.from} (número: ${fromNumber})`);
      
      if (!isNumberAuthorized(fromNumber, numbersFile, dbg)) {
        log(`[CMD] Número ${fromNumber} não está cadastrado. Negando acesso.`);
        const denyMsg = '❌ Você não está autorizado a usar este comando. Seu número precisa estar cadastrado no arquivo de números.';
        try {
          await message.reply(denyMsg);
        } catch (e) {
          err(`[CMD] Falha ao responder negação:`, e.message);
        }
        return;
      }
      
      const rtspUrl = camera.buildRTSPUrl();
      if (!rtspUrl) {
        const configMsg = '❌ Gravação não configurada. Configure CAMERA_RTSP_URL ou CAMERA_USER/CAMERA_PASS.';
        try {
          await message.reply(configMsg);
        } catch (e) {
          err(`[CMD] Falha ao responder erro de configuração:`, e.message);
        }
        return;
      }
      
      const duration = recordMatch[1] ? parseInt(recordMatch[1], 10) : recordDurationSec;
      const finalDuration = Math.min(Math.max(5, duration), 120);
      
      if (duration > 120) {
        const limitMsg = `⚠️ Duração limitada a 120 segundos (solicitado: ${duration}s)`;
        try {
          await message.reply(limitMsg);
        } catch (e) {
          err(`[CMD] Falha ao enviar mensagem de limite:`, e.message);
        }
      }
      
      log(`[CMD] Iniciando gravação de ${finalDuration} segundos para ${message.from}`);
      
      // Processa gravação em background
      (async () => {
        try {
          const result = await camera.recordRTSPVideo(rtspUrl, finalDuration, message);
          
          if (result.success && result.filePath && fs.existsSync(result.filePath)) {
            const originalFilePath = result.filePath;
            const fileStats = fs.statSync(originalFilePath);
            log(`[RECORD] Arquivo gerado: ${originalFilePath} (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            const finalVideoPath = await camera.compressVideoIfNeeded(originalFilePath, message);
            const finalStats = fs.statSync(finalVideoPath);
            log(`[RECORD] Arquivo final para envio: ${finalVideoPath} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`);
            
            const videoBuffer = fs.readFileSync(finalVideoPath);
            
            if (videoBuffer.length === 0) {
              throw new Error('Vídeo está vazio ou corrompido');
            }
            
            const sizeMB = videoBuffer.length / 1024 / 1024;
            if (sizeMB > 16) {
              throw new Error(`Vídeo muito grande (${sizeMB.toFixed(2)} MB). Limite do WhatsApp: 16 MB`);
            }
            
            const videoBase64 = videoBuffer.toString('base64');
            const fileName = `video_${Date.now()}.mp4`;
            const videoMedia = new MessageMedia('video/mp4', videoBase64, fileName);
            const caption = `🎥 Gravação de ${finalDuration} segundos`;
            
            try {
              const sendResult = await client.sendMessage(message.from, videoMedia, { caption });
              log(`[CMD] Vídeo enviado com sucesso como VÍDEO | id=${sendResult.id?._serialized || 'n/a'}`);
              
              camera.cleanupVideoFile(finalVideoPath, 'após envio bem-sucedido (como vídeo)');
              if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
              }
            } catch (sendError) {
              err(`[CMD] Erro ao enviar vídeo como VÍDEO:`, sendError.message);
              
              try {
                const replyResult = await message.reply(videoMedia, undefined, { caption });
                log(`[CMD] Vídeo enviado via message.reply() | id=${replyResult.id?._serialized || 'n/a'}`);
                
                camera.cleanupVideoFile(finalVideoPath, 'após envio (message.reply como vídeo)');
                if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                  camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
                }
              } catch (replyError) {
                err(`[CMD] Erro ao enviar via message.reply():`, replyError.message);
                
                try {
                  const result2 = await message.reply(videoMedia);
                  log(`[CMD] Vídeo enviado sem caption | id=${result2.id?._serialized || 'n/a'}`);
                  await message.reply(caption);
                  
                  camera.cleanupVideoFile(finalVideoPath, 'após envio (sem caption como vídeo)');
                  if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                    camera.cleanupVideoFile(originalFilePath, 'após envio (arquivo original restante)');
                  }
                } catch (sendError2) {
                  err(`[CMD] Erro ao enviar vídeo sem caption:`, sendError2.message);
                  
                  try {
                    const result3 = await client.sendMessage(message.from, videoMedia, { 
                      caption: `${caption}\n\n⚠️ Enviado como documento devido a limitação do WhatsApp Web.`,
                      sendMediaAsDocument: true
                    });
                    log(`[CMD] Vídeo enviado como documento (fallback) | id=${result3.id?._serialized || 'n/a'}`);
                    
                    camera.cleanupVideoFile(finalVideoPath, 'após envio como documento (fallback)');
                    if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                      camera.cleanupVideoFile(originalFilePath, 'após envio como documento (original)');
                    }
                  } catch (sendError3) {
                    err(`[CMD] Erro ao enviar como documento:`, sendError3.message);
                    
                    camera.cleanupVideoFile(finalVideoPath, 'após erro no envio');
                    if (originalFilePath !== finalVideoPath && fs.existsSync(originalFilePath)) {
                      camera.cleanupVideoFile(originalFilePath, 'após erro (original)');
                    }
                    
                    try {
                      await message.reply(`❌ Erro ao enviar vídeo. Tamanho: ${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB. Erro: ${sendError3.message}\n\n💡 O vídeo foi gravado mas não pôde ser enviado. Este é um problema conhecido do WhatsApp Web ao processar vídeos com WebAssembly.`);
                    } catch (e2) {
                      err(`[CMD] Falha ao enviar mensagem de erro do vídeo:`, e2.message);
                    }
                  }
                }
              }
            }
          } else {
            const failMsg = `❌ Falha na gravação: ${result.error || 'Erro desconhecido'}`;
            try {
              await message.reply(failMsg);
            } catch (e) {
              err(`[RECORD] Erro ao enviar mensagem de falha:`, e.message);
            }
            
            if (result.filePath && fs.existsSync(result.filePath)) {
              camera.cleanupVideoFile(result.filePath, 'após falha na gravação');
            }
          }
        } catch (e) {
          err(`[CMD] Erro ao processar gravação:`, e.message);
          err(`[CMD] Stack trace completo:`, e.stack);
          
          try {
            if (typeof result !== 'undefined' && result && result.filePath && fs.existsSync(result.filePath)) {
              camera.cleanupVideoFile(result.filePath, 'após erro geral');
            }
          } catch (cleanupErr) {
            warn(`[CLEANUP] Erro ao limpar após erro geral:`, cleanupErr.message);
          }
          
          const errorMsg = `❌ Erro ao processar gravação: ${e.message}`;
          try {
            await message.reply(errorMsg);
          } catch (e2) {
            err(`[CMD] Falha ao enviar mensagem de erro:`, e2.message);
          }
        }
      })();
      
      return;
    }
    
    // Comandos Tuya
    if (tuya && tuya.formatHelpMessage) {
      const senderNumber = getSenderNumber(message);
      if (!senderNumber) return;
      const isAuthorized = isNumberAuthorized(senderNumber, numbersFile, dbg);
      
      if (!isAuthorized && !msgLower.startsWith('!tuya help')) {
        dbg(`[CMD-TUYA] Número ${senderNumber} não está autorizado. Ignorando comando.`);
        return;
      }
      
      // !tuya help
      if (msgLower === '!tuya help' || msgLower === '!tuya') {
        log(`[CMD-TUYA] Comando help recebido de ${message.from}`);
        try {
          const helpMsg = tuya.formatHelpMessage();
          await message.reply(helpMsg);
          log(`[CMD-TUYA] Mensagem de ajuda enviada para ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Falha ao enviar ajuda:`, e.message);
        }
        return;
      }
      
      // !tuya list
      if (msgLower === '!tuya list') {
        log(`[CMD-TUYA] Comando list recebido de ${message.from}`);
        try {
          await message.reply('⏳ Buscando seus dispositivos...');
          const devices = await tuya.getCachedDevices();
          
          // Tenta enviar lista interativa, com fallback para texto
          try {
            await sendDevicesList(message.from, devices);
          } catch (listError) {
            warn(`[CMD-TUYA] Erro ao enviar lista interativa, usando fallback:`, listError.message);
            const responseMsg = tuya.formatDevicesListMessage(devices);
            await message.reply(responseMsg);
          }
          
          log(`[CMD-TUYA] Lista de ${devices.length} dispositivo(s) enviada para ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao listar dispositivos:`, e.message);
          if (e.message.includes('UID não configurado')) {
            await message.reply(`❌ *Erro:* UID não configurado.\n\nConfigure TUYA_UID no arquivo .env ou use: \`!tuya devices <uid>\``);
          } else {
            await message.reply(`❌ *Erro ao listar dispositivos:*\n${e.message}`);
          }
        }
        return;
      }
      
      // !tuya status <identificador>
      if (msgLower.startsWith('!tuya status ')) {
        const identifier = msgBody.substring(13).trim();
        if (!identifier) {
          await message.reply('❌ *Erro:* Identificador não fornecido.\nUse: `!tuya status 1` ou `!tuya status Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando status recebido de ${message.from} para identificador: ${identifier}`);
        try {
          await message.reply('⏳ Consultando dispositivo...');
          
          let device = null;
          let deviceId = identifier;
          
          try {
            const devices = await tuya.getCachedDevices();
            device = tuya.findDeviceByIdentifier(identifier, devices);
            if (device) {
              deviceId = device.id;
              log(`[CMD-TUYA] Dispositivo encontrado: ${device.name} (${deviceId})`);
            }
          } catch (e) {
            dbg(`[CMD-TUYA] Não foi possível buscar na lista, tentando diretamente com ID: ${e.message}`);
          }
          
          const status = await tuya.getDeviceStatus(deviceId);
          const poweredOn = status.filter(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            if (code.includes('switch') || code.includes('power')) {
              return value === true || value === 1 || value === 'true' || value === 'on';
            }
            return false;
          }).length > 0;
          
          const deviceName = device ? device.name : deviceId;
          const responseMsg = tuya.formatDeviceStatusMessage(deviceName, status, poweredOn);
          await message.reply(responseMsg);
          log(`[CMD-TUYA] Status do dispositivo ${deviceId} enviado para ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao consultar status:`, e.message);
          await message.reply(`❌ *Erro ao consultar dispositivo:*\n${e.message}\n\n💡 *Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
        }
        return;
      }
      
      // !tuya devices <uid>
      if (msgLower.startsWith('!tuya devices ')) {
        const uid = msgBody.substring(14).trim();
        if (!uid) {
          await message.reply('❌ *Erro:* UID não fornecido.\nUse: `!tuya devices <uid>`');
          return;
        }
        
        log(`[CMD-TUYA] Comando devices recebido de ${message.from} para UID ${uid}`);
        try {
          await message.reply('⏳ Consultando dispositivos...');
          const devices = await tuya.getDevices(uid);
          
          const devicesWithStatus = await Promise.all(devices.map(async (device) => {
            try {
              const status = await tuya.getDeviceStatus(device.id);
              const poweredOn = status.filter(s => {
                const code = s.code?.toLowerCase() || '';
                const value = s.value;
                if (code.includes('switch') || code.includes('power')) {
                  return value === true || value === 1 || value === 'true' || value === 'on';
                }
                return false;
              });
              
              return {
                id: device.id,
                name: device.name,
                online: device.online || false,
                category: device.category,
                poweredOn: poweredOn.length > 0,
                poweredOnCount: poweredOn.length
              };
            } catch (e) {
              warn(`[CMD-TUYA] Erro ao obter status do dispositivo ${device.id}:`, e.message);
              return {
                id: device.id,
                name: device.name,
                online: device.online || false,
                category: device.category,
                error: e.message
              };
            }
          }));
          
          const responseMsg = tuya.formatDevicesListMessage(devicesWithStatus);
          await message.reply(responseMsg);
          log(`[CMD-TUYA] Lista de ${devicesWithStatus.length} dispositivo(s) enviada para ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao listar dispositivos:`, e.message);
          await message.reply(`❌ *Erro ao listar dispositivos:*\n${e.message}\n\nVerifique se o UID está correto.`);
        }
        return;
      }
      
      // !tuya on <identificador>
      if (msgLower.startsWith('!tuya on ')) {
        const identifier = msgBody.substring(9).trim();
        if (!identifier) {
          await message.reply('❌ *Erro:* Identificador não fornecido.\nUse: `!tuya on 1` ou `!tuya on Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando on recebido de ${message.from} para identificador: ${identifier}`);
        try {
          await message.reply('⏳ Ligando dispositivo...');
          
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await message.reply(`❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await message.reply(`❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.\n\nStatus atual: ${JSON.stringify(status.map(s => s.code))}`);
            return;
          }
          
          await tuya.sendCommand(device.id, [{ code: switchCode, value: true }]);
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          const newStatus = await tuya.getDeviceStatus(device.id);
          const poweredOn = newStatus.some(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            return code === switchCode.toLowerCase() && (value === true || value === 1 || value === 'true' || value === 'on');
          });
          
          await message.reply(`✅ *Dispositivo ligado!*\n\n*Nome:* ${device.name}\n*Status:* ${poweredOn ? '🟢 LIGADO' : '⚠️ Aguardando confirmação...'}`);
          log(`[CMD-TUYA] Dispositivo ${device.id} (${device.name}) ligado por ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao ligar dispositivo:`, e.message);
          await message.reply(`❌ *Erro ao ligar dispositivo:*\n${e.message}\n\n💡 *Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
        }
        return;
      }
      
      // !tuya off <identificador>
      if (msgLower.startsWith('!tuya off ')) {
        const identifier = msgBody.substring(10).trim();
        if (!identifier) {
          await message.reply('❌ *Erro:* Identificador não fornecido.\nUse: `!tuya off 1` ou `!tuya off Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando off recebido de ${message.from} para identificador: ${identifier}`);
        try {
          await message.reply('⏳ Desligando dispositivo...');
          
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await message.reply(`❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await message.reply(`❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.\n\nStatus atual: ${JSON.stringify(status.map(s => s.code))}`);
            return;
          }
          
          await tuya.sendCommand(device.id, [{ code: switchCode, value: false }]);
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          const newStatus = await tuya.getDeviceStatus(device.id);
          const poweredOn = newStatus.some(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            return code === switchCode.toLowerCase() && (value === true || value === 1 || value === 'true' || value === 'on');
          });
          
          await message.reply(`✅ *Dispositivo desligado!*\n\n*Nome:* ${device.name}\n*Status:* ${poweredOn ? '⚠️ Aguardando confirmação...' : '🔴 DESLIGADO'}`);
          log(`[CMD-TUYA] Dispositivo ${device.id} (${device.name}) desligado por ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao desligar dispositivo:`, e.message);
          await message.reply(`❌ *Erro ao desligar dispositivo:*\n${e.message}\n\n💡 *Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
        }
        return;
      }
      
      // !tuya toggle <identificador>
      if (msgLower.startsWith('!tuya toggle ')) {
        const identifier = msgBody.substring(13).trim();
        if (!identifier) {
          await message.reply('❌ *Erro:* Identificador não fornecido.\nUse: `!tuya toggle 1` ou `!tuya toggle Nome do Dispositivo`');
          return;
        }
        
        log(`[CMD-TUYA] Comando toggle recebido de ${message.from} para identificador: ${identifier}`);
        try {
          await message.reply('⏳ Alternando estado do dispositivo...');
          
          const devices = await tuya.getCachedDevices();
          const device = tuya.findDeviceByIdentifier(identifier, devices);
          
          if (!device) {
            await message.reply(`❌ *Dispositivo não encontrado:* "${identifier}"\n\n💡 Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
            return;
          }
          
          const status = await tuya.getDeviceStatus(device.id);
          const switchCode = tuya.findSwitchCode(status);
          
          if (!switchCode) {
            await message.reply(`❌ *Erro:* Não foi possível encontrar o código de switch/power para este dispositivo.\n\nStatus atual: ${JSON.stringify(status.map(s => s.code))}`);
            return;
          }
          
          const currentSwitch = status.find(s => s.code?.toLowerCase() === switchCode.toLowerCase());
          const currentValue = currentSwitch?.value;
          const isOn = currentValue === true || currentValue === 1 || currentValue === 'true' || currentValue === 'on';
          
          const newValue = !isOn;
          await tuya.sendCommand(device.id, [{ code: switchCode, value: newValue }]);
          
          await new Promise(resolve => setTimeout(resolve, 1000));
          const newStatus = await tuya.getDeviceStatus(device.id);
          const poweredOn = newStatus.some(s => {
            const code = s.code?.toLowerCase() || '';
            const value = s.value;
            return code === switchCode.toLowerCase() && (value === true || value === 1 || value === 'true' || value === 'on');
          });
          
          await message.reply(`✅ *Estado alternado!*\n\n*Nome:* ${device.name}\n*Status anterior:* ${isOn ? '🟢 LIGADO' : '🔴 DESLIGADO'}\n*Status atual:* ${poweredOn ? '🟢 LIGADO' : '🔴 DESLIGADO'}`);
          log(`[CMD-TUYA] Dispositivo ${device.id} (${device.name}) alternado de ${isOn ? 'LIGADO' : 'DESLIGADO'} para ${poweredOn ? 'LIGADO' : 'DESLIGADO'} por ${message.from}.`);
        } catch (e) {
          err(`[CMD-TUYA] Erro ao alternar dispositivo:`, e.message);
          await message.reply(`❌ *Erro ao alternar dispositivo:*\n${e.message}\n\n💡 *Dica:* Use \`!tuya list\` para ver todos os dispositivos disponíveis.`);
        }
        return;
      }
    }
  });
  
  /**
   * Resolve número WhatsApp (com fallback com/sem 9)
   */
  async function resolveWhatsAppNumber(e164) {
    const tried = [];
    const toDigits = s => String(s || '').replace(/\D/g, '');
    tried.push(e164);
    
    // Se cliente não está pronto, usa número diretamente como fallback
    if (!isReady || !client) {
      const normalized = normalizeBR(e164);
      const digits = toDigits(normalized);
      // Cria um objeto Contact simulado para compatibilidade
      return { 
        id: { _serialized: `${digits}@c.us` }, 
        tried: [normalized] 
      };
    }
    
    try {
      let id = await client.getNumberId(toDigits(e164)).catch(() => null);
      if (id) return { id, tried };
      const alt = toggleNineBR(e164);
      if (alt && !tried.includes(alt)) {
        tried.push(alt);
        id = await client.getNumberId(toDigits(alt)).catch(() => null);
        if (id) return { id, tried };
      }
      // Fallback: usa número diretamente mesmo se não encontrado
      const normalized = normalizeBR(e164);
      const digits = toDigits(normalized);
      return { 
        id: { _serialized: `${digits}@c.us` }, 
        tried 
      };
    } catch (e) {
      // Em caso de erro, usa número diretamente
      const normalized = normalizeBR(e164);
      const digits = toDigits(normalized);
      return { 
        id: { _serialized: `${digits}@c.us` }, 
        tried: [normalized] 
      };
    }
  }
  
  /**
   * Inicializa o cliente
   */
  function initialize() {
    log('[INIT] Inicializando cliente WhatsApp...');
    return client.initialize()
      .then(() => {
        log('[INIT] Cliente inicializado com sucesso. Aguardando QR code ou autenticação...');
      })
      .catch(e => {
        err('[INIT] Falha ao inicializar o cliente:', e.message);
        err('[INIT] Stack trace:', e.stack);
      });
  }
  
  return {
    client,
    getLastQR: () => lastQR,
    getIsReady: () => isReady,
    resolveWhatsAppNumber,
    initialize,
    setTempVideoProcessor: (processor) => {
      tempVideoProcessor = processor;
      log(`[WHATSAPP] Processador de vídeos temporários configurado`);
    },
    setListVideosFunction: (listFunction) => {
      listVideosFunction = listFunction;
      log(`[WHATSAPP] Função de listagem de vídeos configurada`);
    },
    setTriggerSnapshotFunction: (triggerFunction) => {
      triggerSnapshotFunction = triggerFunction;
      log(`[WHATSAPP] Função de trigger de snapshot configurada`);
    }
  };
}

module.exports = { initWhatsAppModule };

