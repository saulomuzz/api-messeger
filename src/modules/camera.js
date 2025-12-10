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
 * @param {number} config.maxVideoSizeMB - Tamanho máximo de vídeo em MB antes de comprimir
 * @param {number} config.whatsappMaxVideoSizeMB - Tamanho máximo permitido pela API do WhatsApp
 * @param {number} config.videoCRF - CRF para compressão de vídeo
 * @param {string} config.videoPreset - Preset FFmpeg (ultrafast, fast, medium, slow, etc)
 * @param {string} config.videoProfile - Perfil H.264 (baseline, main, high)
 * @param {string} config.videoLevel - Nível H.264 (3.0, 3.1, 4.0, etc)
 * @param {string} config.videoMaxrate - Bitrate máximo (ex: '3M')
 * @param {string} config.videoBufsize - Tamanho do buffer (ex: '6M')
 * @param {number} config.videoGOP - GOP size
 * @param {number} config.videoMaxWidth - Largura máxima do vídeo
 * @param {number} config.videoMaxHeight - Altura máxima do vídeo
 * @param {string} config.videoAudioBitrate - Bitrate de áudio (ex: '128k')
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
  whatsappMaxVideoSizeMB = 16,
  videoCRF = 32,
  videoPreset = 'medium',
  videoProfile = 'high',
  videoLevel = '4.0',
  videoMaxrate = '3M',
  videoBufsize = '6M',
  videoGOP = 60,
  videoMaxWidth = 1920,
  videoMaxHeight = 1080,
  videoAudioBitrate = '128k',
  logger
}) {
  const { log, dbg, warn, err } = logger;
  const authTypeCache = new Map();
  
  // Armazena whatsappMaxVideoSizeMB no escopo do módulo
  const whatsappMaxVideoSize = whatsappMaxVideoSizeMB;
  
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
   * Comprime vídeo se necessário (mantém qualidade melhor)
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
    
    // Obtém informações do vídeo original para manter resolução se possível
    return new Promise((resolve, reject) => {
      // Primeiro obtém informações do vídeo
      ffmpeg.ffprobe(inputFile, (err, metadata) => {
        if (err) {
          warn(`[COMPRESS] Erro ao obter metadados, usando configuração padrão:`, err.message);
        }
        
        const width = metadata?.streams?.[0]?.width || videoMaxWidth;
        const height = metadata?.streams?.[0]?.height || videoMaxHeight;
        
        // Calcula resolução mantendo aspect ratio, mas limitando se muito grande
        let scaleFilter = '';
        if (width > videoMaxWidth || height > videoMaxHeight) {
          // Redimensiona apenas se for maior que o máximo configurado
          scaleFilter = `scale='min(${videoMaxWidth},iw)':'min(${videoMaxHeight},ih)':force_original_aspect_ratio=decrease`;
        }
        // Se já está em resolução aceitável, não redimensiona
        
        // Calcula bitrate de compressão (um pouco menor que o de gravação)
        const compressMaxrate = videoMaxrate.replace(/\d+/, (match) => {
          const value = parseInt(match);
          return Math.max(1, Math.floor(value * 0.83)).toString(); // ~83% do bitrate original
        });
        const compressBufsize = videoBufsize.replace(/\d+/, (match) => {
          const value = parseInt(match);
          return Math.max(1, Math.floor(value * 0.83)).toString(); // ~83% do buffer original
        });
        
        const outputOptions = [
          '-c:v', 'libx264',
          '-preset', videoPreset,
          '-crf', String(Math.max(18, Math.min(23, videoCRF))), // Garante CRF entre 18-23 (qualidade muito boa)
          '-maxrate', compressMaxrate,
          '-bufsize', compressBufsize,
          '-c:a', 'aac',
          '-b:a', videoAudioBitrate,
          '-ar', '44100',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', videoProfile,
          '-level', videoLevel,
          '-g', String(videoGOP),
          '-keyint_min', String(videoGOP),
          '-sc_threshold', '0',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-strict', '-2'
        ];
        
        // Adiciona scale apenas se necessário
        if (scaleFilter) {
          outputOptions.push('-vf', scaleFilter);
        }
        
        ffmpeg(inputFile)
          .outputOptions(outputOptions)
          .output(compressedFile)
          .on('start', (cmdline) => {
            log(`[COMPRESS] Iniciando compressão com qualidade melhorada (CRF: ${Math.max(18, Math.min(23, videoCRF))})...`);
            if (logger.DEBUG) {
              dbg(`[COMPRESS] Comando: ${cmdline}`);
            }
          })
          .on('end', () => {
            const newStats = fs.statSync(compressedFile);
            const newSizeMB = newStats.size / 1024 / 1024;
            const reduction = ((sizeMB - newSizeMB) / sizeMB * 100).toFixed(1);
            log(`[COMPRESS] Compressão concluída: ${sizeMB.toFixed(2)} MB → ${newSizeMB.toFixed(2)} MB (${reduction}% redução)`);
            
            // Se ainda estiver muito grande, tenta compressão mais agressiva
            if (newSizeMB > maxVideoSizeMB * 1.2) {
              warn(`[COMPRESS] Vídeo ainda grande após compressão (${newSizeMB.toFixed(2)} MB), aplicando compressão adicional...`);
              const moreCompressedFile = compressedFile.replace('.mp4', '_more_compressed.mp4');
              
              // Segunda compressão mais agressiva
              const secondPassMaxrate = compressMaxrate.replace(/\d+/, (match) => {
                const value = parseInt(match);
                return Math.max(1, Math.floor(value * 0.8)).toString(); // 80% do bitrate da primeira passagem
              });
              const secondPassBufsize = compressBufsize.replace(/\d+/, (match) => {
                const value = parseInt(match);
                return Math.max(1, Math.floor(value * 0.8)).toString(); // 80% do buffer da primeira passagem
              });
              
              ffmpeg(compressedFile)
                .outputOptions([
                  '-c:v', 'libx264',
                  '-preset', videoPreset,
                  '-crf', String(Math.min(28, videoCRF + 2)), // CRF um pouco maior para segunda passagem
                  '-maxrate', secondPassMaxrate,
                  '-bufsize', secondPassBufsize,
                  '-vf', scaleFilter || `scale=${Math.floor(videoMaxWidth * 0.67)}:${Math.floor(videoMaxHeight * 0.67)}`, // Redimensiona na segunda passagem se necessário
                  '-c:a', 'aac',
                  '-b:a', videoAudioBitrate.replace(/\d+/, (match) => Math.max(64, Math.floor(parseInt(match) * 0.75)) + 'k'),
                  '-movflags', '+faststart',
                  '-pix_fmt', 'yuv420p'
                ])
                .output(moreCompressedFile)
                .on('end', () => {
                  const finalStats = fs.statSync(moreCompressedFile);
                  const finalSizeMB = finalStats.size / 1024 / 1024;
                  log(`[COMPRESS] Segunda compressão concluída: ${newSizeMB.toFixed(2)} MB → ${finalSizeMB.toFixed(2)} MB`);
                  
                  try {
                    fs.unlinkSync(compressedFile);
                    fs.unlinkSync(inputFile);
                  } catch (e) {
                    warn(`[COMPRESS] Erro ao remover arquivos temporários:`, e.message);
                  }
                  
                  resolve(moreCompressedFile);
                })
                .on('error', (e) => {
                  warn(`[COMPRESS] Erro na segunda compressão, usando primeira:`, e.message);
                  resolve(compressedFile);
                })
                .run();
            } else {
              try {
                fs.unlinkSync(inputFile);
                log(`[COMPRESS] Arquivo original removido`);
              } catch (e) {
                warn(`[COMPRESS] Erro ao remover arquivo original:`, e.message);
              }
              
              resolve(compressedFile);
            }
          })
          .on('error', (ffmpegError) => {
            err(`[COMPRESS] Erro na compressão:`, ffmpegError.message);
            resolve(inputFile); // Retorna original se falhar
          })
          .run();
      });
    });
  }
  
  /**
   * Grava vídeo RTSP por X segundos
   * Suporta múltiplas gravações simultâneas (cada uma cria seu próprio arquivo e processo FFmpeg)
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
    const randomSuffix = Math.random().toString(36).substring(2, 8); // Adiciona sufixo aleatório para evitar colisões
    const outputFile = path.join(recordingsDir, `recording_${timestamp}_${randomSuffix}.mp4`);
    
    // Log de início com identificador único
    const recordId = `REC-${timestamp}-${randomSuffix}`;
    log(`[RECORD][${recordId}] Iniciando gravação de ${durationSeconds}s → ${path.basename(outputFile)}`);
    
    return new Promise((resolve, reject) => {
      let progressInterval = null;
      let lastProgress = 0;
      let hasEnded = false;
      
      // Timeout de segurança (durações + 30 segundos de margem)
      const timeout = setTimeout(() => {
        if (!hasEnded) {
          hasEnded = true;
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          err(`[RECORD][${recordId}] ⏱️ Timeout na gravação após ${durationSeconds + 30} segundos`);
          if (fs.existsSync(outputFile)) {
            const stats = fs.statSync(outputFile);
            if (stats.size > 0) {
              log(`[RECORD] Arquivo parcial encontrado (${(stats.size / 1024 / 1024).toFixed(2)} MB), usando mesmo assim`);
              resolve({ success: true, filePath: outputFile, error: null });
            } else {
              try {
                fs.unlinkSync(outputFile);
              } catch (e) {}
              resolve({ success: false, filePath: null, error: 'Timeout na gravação' });
            }
          } else {
            resolve({ success: false, filePath: null, error: 'Timeout na gravação - arquivo não criado' });
          }
        }
      }, (durationSeconds + 30) * 1000);
      
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
          '-preset', videoPreset,
          '-crf', String(videoCRF),
          '-maxrate', videoMaxrate,
          '-bufsize', videoBufsize,
          '-c:a', 'aac',
          '-b:a', videoAudioBitrate,
          '-ar', '44100',
          '-movflags', '+faststart',
          '-pix_fmt', 'yuv420p',
          '-profile:v', videoProfile,
          '-level', videoLevel,
          '-g', String(videoGOP),
          '-keyint_min', String(videoGOP),
          '-sc_threshold', '0',
          '-avoid_negative_ts', 'make_zero',
          '-fflags', '+genpts',
          '-strict', '-2'
        ])
        .output(outputFile)
        .on('start', (cmdline) => {
          log(`[RECORD][${recordId}] FFmpeg iniciado: ${path.basename(outputFile)}`);
          if (logger.DEBUG) {
            dbg(`[RECORD][${recordId}] Comando ffmpeg: ${cmdline}`);
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
          if (hasEnded) {
            warn(`[RECORD] Evento 'end' recebido após timeout, ignorando`);
            return;
          }
          hasEnded = true;
          clearTimeout(timeout);
          
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          
          // Aguarda um pouco para garantir que o arquivo foi escrito completamente
          setTimeout(() => {
            // Verifica se o arquivo foi criado
            if (!fs.existsSync(outputFile)) {
              err(`[RECORD] Arquivo de saída não encontrado após gravação: ${outputFile}`);
              resolve({ success: false, filePath: null, error: 'Arquivo de saída não foi criado' });
              return;
            }
            
            const stats = fs.statSync(outputFile);
            const sizeMB = stats.size / 1024 / 1024;
            log(`[RECORD][${recordId}] ✅ Gravação concluída: ${path.basename(outputFile)} (${sizeMB.toFixed(2)} MB)`);
            
            if (stats.size === 0) {
              err(`[RECORD] Arquivo de vídeo está vazio (0 bytes)`);
              try {
                fs.unlinkSync(outputFile);
              } catch (e) {
                warn(`[RECORD] Erro ao remover arquivo vazio:`, e.message);
              }
              resolve({ success: false, filePath: null, error: 'Arquivo de vídeo está vazio' });
              return;
            }
            
            const completeMsg = `✅ Gravação concluída! Processando vídeo...`;
            log(`[RECORD] Enviando mensagem: "${completeMsg}"`);
            message.reply(completeMsg)
              .then(() => log(`[RECORD] Mensagem de conclusão enviada`))
              .catch((e) => err(`[RECORD] Erro ao enviar mensagem de conclusão:`, e.message));
            resolve({ success: true, filePath: outputFile, error: null });
          }, 1000); // Aguarda 1 segundo para garantir escrita completa
        })
        .on('error', (ffmpegError, stdout, stderr) => {
          if (hasEnded) {
            warn(`[RECORD] Evento 'error' recebido após timeout/conclusão, ignorando`);
            return;
          }
          hasEnded = true;
          clearTimeout(timeout);
          
          if (progressInterval) {
            clearInterval(progressInterval);
          }
          err(`[RECORD][${recordId}] ❌ Erro na gravação:`, ffmpegError.message);
          if (stderr) {
            dbg(`[RECORD] stderr: ${stderr}`);
          }
          if (stdout) {
            dbg(`[RECORD] stdout: ${stdout}`);
          }
          const errorMsg = `❌ Erro na gravação: ${ffmpegError.message}`;
          log(`[RECORD] Enviando mensagem de erro: "${errorMsg}"`);
          message.reply(errorMsg)
            .then(() => log(`[RECORD] Mensagem de erro enviada`))
            .catch((e) => err(`[RECORD] Erro ao enviar mensagem de erro:`, e.message));
          
          if (fs.existsSync(outputFile)) {
            try {
              fs.unlinkSync(outputFile);
            } catch (e) {
              warn(`[RECORD] Erro ao remover arquivo com erro:`, e.message);
            }
          }
          
          resolve({ success: false, filePath: null, error: ffmpegError.message });
        });
      
      command.run();
    });
  }
  
  /**
   * Divide vídeo em partes se exceder o tamanho máximo do WhatsApp
   * @param {string} inputFile - Caminho do arquivo de vídeo
   * @returns {Promise<Array<string>>} Array com caminhos dos arquivos (pode ser 1 ou mais)
   */
  async function splitVideoIfNeeded(inputFile) {
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Arquivo não encontrado: ${inputFile}`);
    }
    
    const stats = fs.statSync(inputFile);
    const sizeMB = stats.size / 1024 / 1024;
    
    // Se o vídeo já está dentro do limite, retorna o arquivo original
    if (sizeMB <= whatsappMaxVideoSize) {
      log(`[SPLIT] Vídeo não precisa dividir: ${sizeMB.toFixed(2)} MB (limite: ${whatsappMaxVideoSize} MB)`);
      return [inputFile];
    }
    
    // Obtém duração do vídeo
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputFile, (err, metadata) => {
        if (err) {
          err(`[SPLIT] Erro ao obter metadados do vídeo:`, err.message);
          reject(err);
          return;
        }
        
        const duration = metadata.format.duration; // em segundos
        if (!duration || duration <= 0) {
          err(`[SPLIT] Duração inválida do vídeo: ${duration}`);
          reject(new Error('Duração inválida do vídeo'));
          return;
        }
        
        // Calcula quantas partes são necessárias
        const partsNeeded = Math.ceil(sizeMB / whatsappMaxVideoSize);
        const durationPerPart = duration / partsNeeded;
        
        log(`[SPLIT] Vídeo muito grande (${sizeMB.toFixed(2)} MB), dividindo em ${partsNeeded} parte(s) de ~${durationPerPart.toFixed(1)}s cada`);
        
        const outputFiles = [];
        let partsCompleted = 0;
        let hasError = false;
        
        // Cria cada parte do vídeo
        for (let i = 0; i < partsNeeded; i++) {
          const startTime = i * durationPerPart;
          const partFile = inputFile.replace('.mp4', `_part${i + 1}_of_${partsNeeded}.mp4`);
          outputFiles.push(partFile);
          
          ffmpeg(inputFile)
            .outputOptions([
              '-ss', String(startTime),
              '-t', String(durationPerPart),
              '-c', 'copy', // Copia sem re-encoding para manter qualidade
              '-avoid_negative_ts', 'make_zero'
            ])
            .output(partFile)
            .on('start', (cmdline) => {
              log(`[SPLIT] Criando parte ${i + 1}/${partsNeeded}...`);
              if (logger.DEBUG) {
                dbg(`[SPLIT] Comando: ${cmdline}`);
              }
            })
            .on('end', () => {
              partsCompleted++;
              const partStats = fs.statSync(partFile);
              const partSizeMB = partStats.size / 1024 / 1024;
              log(`[SPLIT] Parte ${i + 1}/${partsNeeded} criada: ${partFile} (${partSizeMB.toFixed(2)} MB)`);
              
              if (partsCompleted === partsNeeded) {
                // Todas as partes foram criadas
                log(`[SPLIT] Todas as ${partsNeeded} parte(s) foram criadas com sucesso`);
                
                // Remove arquivo original se todas as partes foram criadas
                try {
                  fs.unlinkSync(inputFile);
                  log(`[SPLIT] Arquivo original removido`);
                } catch (e) {
                  warn(`[SPLIT] Erro ao remover arquivo original:`, e.message);
                }
                
                resolve(outputFiles);
              }
            })
            .on('error', (ffmpegError) => {
              if (hasError) return;
              hasError = true;
              err(`[SPLIT] Erro ao criar parte ${i + 1}/${partsNeeded}:`, ffmpegError.message);
              
              // Limpa partes já criadas
              outputFiles.forEach(file => {
                if (fs.existsSync(file)) {
                  try {
                    fs.unlinkSync(file);
                  } catch (e) {}
                }
              });
              
              reject(ffmpegError);
            })
            .run();
        }
      });
    });
  }
  
  // Retorna API pública do módulo
  return {
    downloadSnapshot: (url) => downloadSnapshot(url || snapshotUrl, username, password),
    buildRTSPUrl,
    recordRTSPVideo,
    compressVideoIfNeeded,
    splitVideoIfNeeded,
    cleanupVideoFile,
    optimizeImage,
    get ffmpegConfigured() { return ffmpegConfigured; }
  };
}

module.exports = { initCameraModule };

