/**
 * Módulo de Câmera
 * Gerencia operações relacionadas à câmera IP (snapshots, gravação RTSP)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

/**
 * Inicializa o módulo de câmera
 * @param {Object} config - Configuração do módulo
 * @param {string} config.snapshotUrl - URL do snapshot
 * @param {string} config.username - Usuário da câmera
 * @param {string} config.password - Senha da câmera
 * @param {string} config.rtspUrl - URL RTSP
 * @param {string} config.recordingsDir - Diretório de gravações
 * @param {number} config.recordDurationSec - Duração padrão de gravação
 * @param {number} config.maxImageSizeKB - Tamanho máximo de imagem em KB
 * @param {number} config.maxImageWidth - Largura máxima de imagem
 * @param {number} config.maxImageHeight - Altura máxima de imagem
 * @param {number} config.jpegQuality - Qualidade JPEG
 * @param {number} config.maxVideoSizeMB - Tamanho máximo de vídeo em MB
 * @param {number} config.videoCRF - CRF para compressão de vídeo
 * @param {Object} config.logger - Objeto com funções de log
 * @returns {Object} API do módulo de câmera
 */
function initCameraModule({
  snapshotUrl,
  username,
  password,
  rtspUrl,
  recordingsDir,
  recordDurationSec = 30,
  maxImageSizeKB = 500,
  maxImageWidth = 1920,
  maxImageHeight = 1080,
  jpegQuality = 85,
  maxVideoSizeMB = 8,
  videoCRF = 32,
  logger
}) {
  const { log, dbg, warn, err } = logger;
  const authTypeCache = new Map();
  
  // Configura FFmpeg
  let ffmpegConfigured = false;
  if (ffmpegPath) {
    try {
      ffmpeg.setFfmpegPath(ffmpegPath);
      if (fs.existsSync(ffmpegPath)) {
        ffmpegConfigured = true;
        log(`[CAMERA] FFmpeg configurado: ${ffmpegPath}`);
      } else {
        warn(`[CAMERA] FFmpeg path não encontrado: ${ffmpegPath}`);
      }
    } catch (e) {
      warn(`[CAMERA] Erro ao configurar ffmpeg-static:`, e.message);
    }
  }
  
  // Fallback: tenta usar ffmpeg do sistema
  if (!ffmpegConfigured) {
    const { execSync } = require('child_process');
    const os = require('os');
    try {
      const command = os.platform() === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
      execSync(command, { stdio: 'ignore' });
      ffmpegConfigured = true;
      log(`[CAMERA] Usando ffmpeg do sistema (PATH)`);
    } catch (e) {
      warn(`[CAMERA] FFmpeg não encontrado no sistema. Instale ffmpeg ou use ffmpeg-static.`);
    }
  }
  
  /**
   * Otimiza imagem: redimensiona e comprime se necessário
   */
  async function optimizeImage(imageBuffer, mimeType) {
    const originalSizeKB = imageBuffer.length / 1024;
    let optimized = false;
    let processedBuffer = imageBuffer;
    
    try {
      if (!mimeType.match(/^image\/(jpeg|jpg|png)$/i)) {
        if (logger.DEBUG) {
          dbg(`[OPTIMIZE] Tipo ${mimeType} não suportado para otimização, mantendo original`);
        }
        return { buffer: imageBuffer, mimeType, optimized: false };
      }
      
      let sharpImage = sharp(imageBuffer);
      const metadata = await sharpImage.metadata();
      
      const needsResize = metadata.width > maxImageWidth || metadata.height > maxImageHeight;
      const needsCompress = originalSizeKB > maxImageSizeKB;
      
      if (!needsResize && !needsCompress) {
        if (logger.DEBUG) {
          dbg(`[OPTIMIZE] Imagem já otimizada: ${originalSizeKB.toFixed(1)}KB, ${metadata.width}x${metadata.height}px`);
        }
        return { buffer: imageBuffer, mimeType, optimized: false };
      }
      
      if (logger.DEBUG) {
        dbg(`[OPTIMIZE] Otimizando imagem: ${originalSizeKB.toFixed(1)}KB, ${metadata.width}x${metadata.height}px`);
      }
      
      if (needsResize) {
        sharpImage = sharpImage.resize(maxImageWidth, maxImageHeight, {
          fit: 'inside',
          withoutEnlargement: true
        });
        if (logger.DEBUG) {
          dbg(`[OPTIMIZE] Redimensionando para máximo ${maxImageWidth}x${maxImageHeight}px`);
        }
      }
      
      if (mimeType.match(/^image\/(jpeg|jpg)$/i)) {
        processedBuffer = await sharpImage
          .jpeg({ quality: jpegQuality, mozjpeg: true })
          .toBuffer();
        optimized = true;
      } else if (mimeType.match(/^image\/png$/i)) {
        processedBuffer = await sharpImage
          .jpeg({ quality: jpegQuality, mozjpeg: true })
          .toBuffer();
        mimeType = 'image/jpeg';
        optimized = true;
      }
      
      const newSizeKB = processedBuffer.length / 1024;
      const reduction = ((originalSizeKB - newSizeKB) / originalSizeKB * 100).toFixed(1);
      
      if (optimized) {
        log(`[OPTIMIZE] Imagem otimizada: ${originalSizeKB.toFixed(1)}KB → ${newSizeKB.toFixed(1)}KB (${reduction}% redução)`);
      }
      
      return { buffer: processedBuffer, mimeType, optimized };
    } catch (error) {
      warn(`[OPTIMIZE] Erro ao otimizar imagem, usando original:`, error.message);
      return { buffer: imageBuffer, mimeType, optimized: false };
    }
  }
  
  /**
   * Adiciona parâmetros de otimização na URL da câmera
   */
  function optimizeCameraUrl(url) {
    try {
      const urlObj = new URL(url);
      if (!urlObj.searchParams.has('resolution') && !urlObj.searchParams.has('width')) {
        urlObj.searchParams.set('resolution', `${maxImageWidth}x${maxImageHeight}`);
      }
      if (!urlObj.searchParams.has('quality')) {
        urlObj.searchParams.set('quality', String(jpegQuality));
      }
      if (!urlObj.searchParams.has('compression')) {
        urlObj.searchParams.set('compression', 'high');
      }
      if (!urlObj.searchParams.has('subtype') && !urlObj.searchParams.has('subType')) {
        urlObj.searchParams.set('subtype', '0');
      }
      return urlObj.toString();
    } catch (e) {
      return url;
    }
  }
  
  /**
   * Baixa snapshot da câmera com autenticação (Basic ou Digest)
   */
  async function downloadSnapshot(url, username, password) {
    if (!username || !password) {
      throw new Error('CAMERA_USER e CAMERA_PASS devem estar configurados');
    }
    
    const cleanUrl = url.replace(/\/\/[^@]+@/, '//');
    const optimizedUrl = optimizeCameraUrl(cleanUrl);
    const displayUrl = optimizedUrl !== cleanUrl ? `${cleanUrl} [otimizado]` : cleanUrl;
    
    log(`[SNAPSHOT] Baixando snapshot de ${displayUrl}`);
    
    if (logger.DEBUG) {
      dbg(`[SNAPSHOT] Credenciais - User: ${username}, Pass: ${password}`);
      dbg(`[SNAPSHOT] URL original: ${cleanUrl}`);
      if (optimizedUrl !== cleanUrl) {
        dbg(`[SNAPSHOT] URL otimizada: ${optimizedUrl}`);
      }
    }
    
    const downloadUrl = optimizedUrl;
    const cachedAuthType = authTypeCache.get(cleanUrl);
    
    // Se cache indica Digest, tenta primeiro
    if (cachedAuthType === 'digest') {
      if (logger.DEBUG) {
        dbg(`[SNAPSHOT] Cache indica Digest - fazendo requisição inicial para obter nonce`);
      }
      try {
        const initialResponse = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 3000,
          validateStatus: () => true,
          headers: {
            'User-Agent': 'WhatsApp-API/1.0',
            'Accept': 'image/*,*/*',
            'Connection': 'keep-alive'
          }
        });
        
        if (initialResponse.status === 200 && initialResponse.data) {
          let buffer = Buffer.from(initialResponse.data);
          let mimeType = initialResponse.headers['content-type'] || 'image/jpeg';
          const optimized = await optimizeImage(buffer, mimeType);
          buffer = optimized.buffer;
          mimeType = optimized.mimeType;
          const base64 = buffer.toString('base64');
          log(`[SNAPSHOT] Snapshot baixado (sem auth): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
          return { base64, mimeType, buffer };
        }
        
        if (initialResponse.status === 401) {
          const wwwAuth = initialResponse.headers['www-authenticate'] || '';
          const isDigest = wwwAuth.toLowerCase().includes('digest');
          
          if (isDigest) {
            const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
            const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);
            const qopMatch = wwwAuth.match(/qop="([^"]+)"/);
            const opaqueMatch = wwwAuth.match(/opaque="([^"]+)"/);
            
            const realm = realmMatch ? realmMatch[1] : '';
            const nonce = nonceMatch ? nonceMatch[1] : '';
            const qop = qopMatch ? qopMatch[1] : '';
            const opaque = opaqueMatch ? opaqueMatch[1] : '';
            
            const urlObj = new URL(downloadUrl);
            const uri = urlObj.pathname + urlObj.search;
            const method = 'GET';
            
            if (logger.DEBUG) {
              dbg(`[SNAPSHOT] Digest params - realm: "${realm}", nonce: "${nonce}", qop: "${qop}", opaque: "${opaque}"`);
              dbg(`[SNAPSHOT] URI: "${uri}", Method: "${method}"`);
            }
            
            const ha1Input = `${username}:${realm}:${password}`;
            const ha1 = crypto.createHash('md5').update(ha1Input).digest('hex');
            
            const ha2Input = `${method}:${uri}`;
            const ha2 = crypto.createHash('md5').update(ha2Input).digest('hex');
            
            const cnonce = crypto.randomBytes(8).toString('hex');
            const nc = '00000001';
            
            let responseHash = '';
            if (qop) {
              const responseInput = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;
              responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
            } else {
              const responseInput = `${ha1}:${nonce}:${ha2}`;
              responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
            }
            
            if (logger.DEBUG) {
              dbg(`[SNAPSHOT] HA1: ${ha1}, HA2: ${ha2}, Response: ${responseHash}`);
            }
            
            let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
            if (qop) {
              authHeader += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
            }
            if (opaque) {
              authHeader += `, opaque="${opaque}"`;
            }
            
            const response = await axios.get(downloadUrl, {
              responseType: 'arraybuffer',
              timeout: 20000,
              headers: {
                'User-Agent': 'WhatsApp-API/1.0',
                'Accept': 'image/*,*/*',
                'Authorization': authHeader,
                'Connection': 'keep-alive'
              },
              validateStatus: (status) => status === 200,
              maxRedirects: 0
            });
            
            if (!response.data || response.data.length === 0) {
              throw new Error('Resposta vazia da câmera');
            }
            
            let buffer = Buffer.from(response.data);
            let mimeType = response.headers['content-type'] || 'image/jpeg';
            const optimized = await optimizeImage(buffer, mimeType);
            buffer = optimized.buffer;
            mimeType = optimized.mimeType;
            const base64 = buffer.toString('base64');
            log(`[SNAPSHOT] Snapshot baixado com sucesso (Digest - cache): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
            return { base64, mimeType, buffer };
          }
        }
        throw new Error('Unexpected response from camera');
      } catch (e) {
        if (logger.DEBUG) {
          dbg(`[SNAPSHOT] Erro ao usar cache Digest, limpando cache e tentando Basic:`, e.message);
        }
        authTypeCache.delete(cleanUrl);
      }
    }
    
    // Tenta Basic primeiro
    const currentCache = authTypeCache.get(cleanUrl);
    if (currentCache !== 'digest') {
      try {
        if (logger.DEBUG) {
          dbg(`[SNAPSHOT] Tentando autenticação Basic HTTP`);
        }
        
        const response = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 5000,
          auth: { username, password },
          validateStatus: (status) => status === 200,
          headers: {
            'User-Agent': 'WhatsApp-API/1.0',
            'Accept': 'image/*,*/*',
            'Connection': 'keep-alive'
          },
          maxRedirects: 0
        });
        
        if (!response.data || response.data.length === 0) {
          throw new Error('Resposta vazia da câmera');
        }
        
        let buffer = Buffer.from(response.data);
        let mimeType = response.headers['content-type'] || 'image/jpeg';
        const optimized = await optimizeImage(buffer, mimeType);
        buffer = optimized.buffer;
        mimeType = optimized.mimeType;
        const base64 = buffer.toString('base64');
        log(`[SNAPSHOT] Snapshot baixado com sucesso (Basic): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
        authTypeCache.set(cleanUrl, 'basic');
        return { base64, mimeType, buffer };
      } catch (e1) {
        if (e1.response?.status === 401) {
          const wwwAuth = e1.response?.headers['www-authenticate'] || '';
          const isDigest = wwwAuth.toLowerCase().includes('digest');
          
          if (logger.DEBUG) {
            dbg(`[SNAPSHOT] Resposta 401 recebida`);
            dbg(`[SNAPSHOT] WWW-Authenticate header: ${wwwAuth || '(não presente)'}`);
            dbg(`[SNAPSHOT] Tipo de autenticação detectado: ${isDigest ? 'Digest' : 'Basic (ou não especificado)'}`);
          }
          
          authTypeCache.set(cleanUrl, 'digest');
          
          if (isDigest) {
            try {
              if (logger.DEBUG) {
                dbg(`[SNAPSHOT] Tentando autenticação Digest HTTP`);
              }
              
              const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
              const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);
              const qopMatch = wwwAuth.match(/qop="([^"]+)"/);
              const opaqueMatch = wwwAuth.match(/opaque="([^"]+)"/);
              
              const realm = realmMatch ? realmMatch[1] : '';
              const nonce = nonceMatch ? nonceMatch[1] : '';
              const qop = qopMatch ? qopMatch[1] : '';
              const opaque = opaqueMatch ? opaqueMatch[1] : '';
              
              const urlObj = new URL(downloadUrl);
              const uri = urlObj.pathname + urlObj.search;
              const method = 'GET';
              
              if (logger.DEBUG) {
                dbg(`[SNAPSHOT] Digest params - realm: "${realm}", nonce: "${nonce}", qop: "${qop}", opaque: "${opaque}"`);
              }
              
              const ha1Input = `${username}:${realm}:${password}`;
              const ha1 = crypto.createHash('md5').update(ha1Input).digest('hex');
              
              const ha2Input = `${method}:${uri}`;
              const ha2 = crypto.createHash('md5').update(ha2Input).digest('hex');
              
              const cnonce = crypto.randomBytes(8).toString('hex');
              const nc = '00000001';
              
              let responseHash = '';
              if (qop) {
                const responseInput = `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`;
                responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
              } else {
                const responseInput = `${ha1}:${nonce}:${ha2}`;
                responseHash = crypto.createHash('md5').update(responseInput).digest('hex');
              }
              
              let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${responseHash}"`;
              if (qop) {
                authHeader += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
              }
              if (opaque) {
                authHeader += `, opaque="${opaque}"`;
              }
              
              const response = await axios.get(downloadUrl, {
                responseType: 'arraybuffer',
                timeout: 20000,
                headers: {
                  'User-Agent': 'WhatsApp-API/1.0',
                  'Accept': 'image/*,*/*',
                  'Authorization': authHeader,
                  'Connection': 'keep-alive'
                },
                validateStatus: (status) => status === 200,
                maxRedirects: 0
              });
              
              if (!response.data || response.data.length === 0) {
                throw new Error('Resposta vazia da câmera');
              }
              
              let buffer = Buffer.from(response.data);
              let mimeType = response.headers['content-type'] || 'image/jpeg';
              const optimized = await optimizeImage(buffer, mimeType);
              buffer = optimized.buffer;
              mimeType = optimized.mimeType;
              const base64 = buffer.toString('base64');
              log(`[SNAPSHOT] Snapshot baixado com sucesso (Digest): ${buffer.length} bytes, tipo: ${mimeType}${optimized.optimized ? ' [OTIMIZADO]' : ''}`);
              return { base64, mimeType, buffer };
            } catch (e2) {
              if (logger.DEBUG) {
                dbg(`[SNAPSHOT] Erro na autenticação Digest:`, e2.message);
              }
              const status = e2.response?.status || e1.response?.status;
              if (status === 401) {
                err(`[SNAPSHOT] Erro 401 - Autenticação Digest falhou. Verifique CAMERA_USER e CAMERA_PASS.`);
                err(`[SNAPSHOT] WWW-Authenticate: ${wwwAuth}`);
              } else {
                err(`[SNAPSHOT] Erro HTTP ${status}:`, e2.message);
              }
              throw e2;
            }
          } else {
            err(`[SNAPSHOT] Erro 401 - Autenticação Basic falhou. Verifique CAMERA_USER e CAMERA_PASS.`);
            err(`[SNAPSHOT] WWW-Authenticate: ${wwwAuth || '(não fornecido)'}`);
            throw e1;
          }
        } else {
          const status = e1.response?.status;
          const statusText = e1.response?.statusText;
          if (status) {
            err(`[SNAPSHOT] Erro HTTP ${status} ${statusText || ''}:`, e1.message);
          } else {
            err(`[SNAPSHOT] Erro ao baixar snapshot:`, e1.message);
          }
          throw e1;
        }
      }
    }
  }
  
  /**
   * Constrói URL RTSP com credenciais se necessário
   */
  function buildRTSPUrl() {
    if (rtspUrl && rtspUrl.includes('@')) {
      return rtspUrl;
    }
    
    if (!rtspUrl && username && password && snapshotUrl) {
      const match = snapshotUrl.match(/https?:\/\/([^\/]+)/);
      if (match) {
        const host = match[1].replace(/^[^@]+@/, '');
        return `rtsp://${username}:${password}@${host}:554/cam/realmonitor?channel=1&subtype=0`;
      }
    }
    
    if (rtspUrl && !rtspUrl.includes('@') && username && password) {
      const url = rtspUrl.replace(/^rtsp:\/\//, '');
      return `rtsp://${username}:${password}@${url}`;
    }
    
    return rtspUrl || '';
  }
  
  /**
   * Remove arquivo de vídeo de forma segura
   */
  function cleanupVideoFile(filePath, context = '') {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log(`[CLEANUP] Arquivo removido ${context}: ${filePath}`);
      }
    } catch (e) {
      warn(`[CLEANUP] Erro ao remover arquivo ${context}:`, e.message);
    }
  }
  
  /**
   * Comprime vídeo se necessário
   */
  async function compressVideoIfNeeded(inputFile, message = null) {
    const stats = fs.statSync(inputFile);
    const sizeMB = stats.size / 1024 / 1024;
    
    if (sizeMB <= maxVideoSizeMB) {
      log(`[COMPRESS] Vídeo não precisa comprimir: ${sizeMB.toFixed(2)} MB (limite: ${maxVideoSizeMB} MB)`);
      return inputFile;
    }
    
    log(`[COMPRESS] Vídeo muito grande (${sizeMB.toFixed(2)} MB), comprimindo para ${maxVideoSizeMB} MB...`);
    if (message) {
      const compressMsg = `📦 Comprimindo vídeo (${sizeMB.toFixed(1)} MB → ~${maxVideoSizeMB} MB)...`;
      log(`[COMPRESS] Enviando mensagem: "${compressMsg}"`);
      message.reply(compressMsg)
        .then(() => log(`[COMPRESS] Mensagem de compressão enviada`))
        .catch((e) => err(`[COMPRESS] Erro ao enviar mensagem:`, e.message));
    }
    
    const compressedFile = inputFile.replace('.mp4', '_compressed.mp4');
    
    return new Promise((resolve, reject) => {
      ffmpeg(inputFile)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', String(videoCRF),
          '-maxrate', '1.5M',
          '-bufsize', '3M',
          '-vf', 'scale=1280:720',
          '-c:a', 'aac',
          '-b:a', '96k',
          '-ar', '44100',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-g', '30',
          '-keyint_min', '30',
          '-sc_threshold', '0',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-strict', '-2'
        ])
        .output(compressedFile)
        .on('start', (cmdline) => {
          log(`[COMPRESS] Iniciando compressão...`);
          if (logger.DEBUG) {
            dbg(`[COMPRESS] Comando: ${cmdline}`);
          }
        })
        .on('end', () => {
          const newStats = fs.statSync(compressedFile);
          const newSizeMB = newStats.size / 1024 / 1024;
          const reduction = ((sizeMB - newSizeMB) / sizeMB * 100).toFixed(1);
          log(`[COMPRESS] Compressão concluída: ${sizeMB.toFixed(2)} MB → ${newSizeMB.toFixed(2)} MB (${reduction}% redução)`);
          
          try {
            fs.unlinkSync(inputFile);
            log(`[COMPRESS] Arquivo original removido`);
          } catch (e) {
            warn(`[COMPRESS] Erro ao remover arquivo original:`, e.message);
          }
          
          resolve(compressedFile);
        })
        .on('error', (ffmpegError) => {
          err(`[COMPRESS] Erro na compressão:`, ffmpegError.message);
          resolve(inputFile);
        })
        .run();
    });
  }
  
  /**
   * Grava vídeo RTSP por X segundos
   */
  async function recordRTSPVideo(rtspUrl, durationSeconds, message) {
    if (!rtspUrl) {
      throw new Error('CAMERA_RTSP_URL não configurada');
    }
    
    if (!ffmpegConfigured) {
      const errorMsg = 'FFmpeg não está disponível. Instale ffmpeg no sistema ou verifique a instalação do ffmpeg-static.';
      err(`[RECORD] ${errorMsg}`);
      throw new Error(errorMsg);
    }
    
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
      log(`[RECORD] Diretório de gravações criado: ${recordingsDir}`);
    }
    
    const timestamp = Date.now();
    const outputFile = path.join(recordingsDir, `recording_${timestamp}.mp4`);
    
    return new Promise((resolve, reject) => {
      let progressInterval = null;
      let lastProgress = 0;
      
      const initialMsg = `🎥 Iniciando gravação de ${durationSeconds} segundos...`;
      log(`[RECORD] Enviando mensagem: "${initialMsg}"`);
      message.reply(initialMsg)
        .then(() => log(`[RECORD] Mensagem enviada com sucesso: "${initialMsg}"`))
        .catch((e) => err(`[RECORD] Erro ao enviar mensagem inicial:`, e.message));
      
      const command = ffmpeg()
        .input(rtspUrl)
        .inputOptions([
          '-rtsp_transport', 'tcp',
          '-timeout', '5000000',
          '-rtsp_flags', 'prefer_tcp'
        ])
        .outputOptions([
          '-t', String(durationSeconds),
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-maxrate', '2M',
          '-bufsize', '4M',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-ar', '44100',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', 'baseline',
          '-level', '3.1',
          '-g', '30',
          '-keyint_min', '30',
          '-sc_threshold', '0',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-strict', '-2'
        ])
        .output(outputFile)
        .on('start', (cmdline) => {
          log(`[RECORD] Iniciando gravação: ${outputFile}`);
          if (logger.DEBUG) {
            dbg(`[RECORD] Comando ffmpeg: ${cmdline}`);
          }
          
          progressInterval = setInterval(() => {
            const elapsed = Date.now() - timestamp;
            const progress = Math.min(100, Math.floor((elapsed / (durationSeconds * 1000)) * 100));
            
            if (progress >= lastProgress + 25 && progress <= 100) {
              lastProgress = progress;
              const remaining = Math.max(0, durationSeconds - Math.floor(elapsed / 1000));
              const progressMsg = `⏳ Gravando... ${progress}% (${remaining}s restantes)`;
              log(`[RECORD] Enviando progresso: "${progressMsg}"`);
              message.reply(progressMsg)
                .then(() => log(`[RECORD] Progresso enviado: ${progress}%`))
                .catch((e) => err(`[RECORD] Erro ao enviar progresso:`, e.message));
            }
          }, 1000);
        })
        .on('progress', (progress) => {
          if (logger.DEBUG && progress.percent) {
            dbg(`[RECORD] Progresso: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => {
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          log(`[RECORD] Gravação concluída: ${outputFile}`);
          const completeMsg = `✅ Gravação concluída! Processando vídeo...`;
          log(`[RECORD] Enviando mensagem: "${completeMsg}"`);
          message.reply(completeMsg)
            .then(() => log(`[RECORD] Mensagem de conclusão enviada`))
            .catch((e) => err(`[RECORD] Erro ao enviar mensagem de conclusão:`, e.message));
          resolve({ success: true, filePath: outputFile, error: null });
        })
        .on('error', (ffmpegError, stdout, stderr) => {
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          err(`[RECORD] Erro na gravação:`, ffmpegError.message);
          if (stderr) {
            dbg(`[RECORD] stderr: ${stderr}`);
          }
          const errorMsg = `❌ Erro na gravação: ${ffmpegError.message}`;
          log(`[RECORD] Enviando mensagem de erro: "${errorMsg}"`);
          message.reply(errorMsg)
            .then(() => log(`[RECORD] Mensagem de erro enviada`))
            .catch((e) => err(`[RECORD] Erro ao enviar mensagem de erro:`, e.message));
          
          if (fs.existsSync(outputFile)) {
            fs.unlinkSync(outputFile);
          }
          
          resolve({ success: false, filePath: null, error: ffmpegError.message });
        });
      
      command.run();
    });
  }
  
  // Retorna API pública do módulo
  return {
    downloadSnapshot: (url) => downloadSnapshot(url || snapshotUrl, username, password),
    buildRTSPUrl,
    recordRTSPVideo,
    compressVideoIfNeeded,
    cleanupVideoFile,
    optimizeImage,
    get ffmpegConfigured() { return ffmpegConfigured; }
  };
}

module.exports = { initCameraModule };

