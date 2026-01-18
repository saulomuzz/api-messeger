/**
 * Rotas do Dashboard
 */

function createDashboardRoutes({ app, requireAuth, dashboardController, logger, getVideoManager, getAuditStore }) {
  const { log, err, warn } = logger;
  
  // Endpoint principal de estatísticas do dashboard
  app.get('/admin/api/dashboard/stats', requireAuth, async (req, res) => {
    try {
      const stats = await dashboardController.getDashboardStats();
      res.json(stats);
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao obter estatísticas do dashboard:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
  
  // Endpoint de estatísticas em tempo real (para atualização automática)
  app.get('/admin/api/dashboard/realtime', requireAuth, async (req, res) => {
    try {
      const stats = await dashboardController.getDashboardStats();
      res.json(stats);
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao obter estatísticas em tempo real:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ===== Vídeos temporários (Admin) =====
  app.get('/admin/api/videos', requireAuth, async (_req, res) => {
    try {
      const videoManager = typeof getVideoManager === 'function' ? getVideoManager() : null;
      if (!videoManager || typeof videoManager.listVideos !== 'function') {
        return res.status(503).json({ success: false, error: 'video_manager_unavailable' });
      }
      const videos = videoManager.listVideos(null);
      res.json({ success: true, videos });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao listar vídeos:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/admin/api/videos/:videoId/stream', requireAuth, async (req, res) => {
    try {
      const { videoId } = req.params;
      const videoManager = typeof getVideoManager === 'function' ? getVideoManager() : null;
      if (!videoManager || typeof videoManager.getVideoById !== 'function') {
        return res.status(503).json({ success: false, error: 'video_manager_unavailable' });
      }
      const video = videoManager.getVideoById(videoId);
      if (!video || !video.filePath || !video.fileExists) {
        return res.status(404).json({ success: false, error: 'video_not_found' });
      }
      const fs = require('fs');
      const stat = fs.statSync(video.filePath);
      const fileSize = stat.size;
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        const file = fs.createReadStream(video.filePath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4'
        });
        file.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4'
        });
        fs.createReadStream(video.filePath).pipe(res);
      }
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao streamar vídeo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/admin/api/videos/:videoId', requireAuth, async (req, res) => {
    try {
      const { videoId } = req.params;
      const videoManager = typeof getVideoManager === 'function' ? getVideoManager() : null;
      if (!videoManager || typeof videoManager.deleteTempVideo !== 'function') {
        return res.status(503).json({ success: false, error: 'video_manager_unavailable' });
      }
      const result = videoManager.deleteTempVideo(videoId);
      if (!result.success) {
        return res.status(400).json({ success: false, error: result.error || 'delete_failed' });
      }
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao remover vídeo:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/admin/api/videos/:videoId/viewed', requireAuth, async (req, res) => {
    try {
      const { videoId } = req.params;
      const videoManager = typeof getVideoManager === 'function' ? getVideoManager() : null;
      if (!videoManager || typeof videoManager.markVideoViewed !== 'function') {
        return res.status(503).json({ success: false, error: 'video_manager_unavailable' });
      }
      videoManager.markVideoViewed(videoId, req.adminPhone || null);
      res.json({ success: true });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao marcar vídeo como visto:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ===== WhatsApp Audit =====
  app.get('/admin/api/whatsapp/audit/threads', requireAuth, async (req, res) => {
    try {
      const auditStore = typeof getAuditStore === 'function' ? getAuditStore() : null;
      if (!auditStore || typeof auditStore.listWhatsappThreads !== 'function') {
        return res.status(503).json({ success: false, error: 'audit_store_unavailable' });
      }
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      const search = String(req.query.search || '').trim();
      const threads = await auditStore.listWhatsappThreads(limit, offset, search);
      res.json({ success: true, threads });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao listar threads WhatsApp:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/admin/api/whatsapp/audit/messages', requireAuth, async (req, res) => {
    try {
      const auditStore = typeof getAuditStore === 'function' ? getAuditStore() : null;
      if (!auditStore || typeof auditStore.listWhatsappMessages !== 'function') {
        return res.status(503).json({ success: false, error: 'audit_store_unavailable' });
      }
      const phone = String(req.query.phone || '').trim();
      const limit = parseInt(req.query.limit || '50', 10);
      const before = req.query.before ? parseInt(req.query.before, 10) : null;
      const messages = await auditStore.listWhatsappMessages(phone, limit, before);
      const mediaIds = new Set();
      const mediaToFetch = [];
      for (const msg of messages) {
        if (!msg.payload_json) continue;
        try {
          const payload = JSON.parse(msg.payload_json);
          const mediaId = payload?.image?.id || payload?.video?.id || payload?.audio?.id || payload?.document?.id || payload?.mediaId || null;
          if (mediaId && !mediaIds.has(mediaId)) {
            mediaIds.add(mediaId);
            mediaToFetch.push(mediaId);
          }
        } catch {}
      }
      const media = {};
      if (mediaToFetch.length > 0 && typeof fetch === 'function') {
        const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        const apiVersion = process.env.WHATSAPP_API_VERSION || 'v21.0';
        if (phoneNumberId && accessToken) {
          for (const mediaId of mediaToFetch) {
            try {
              const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              const meta = await metaRes.json();
              const url = meta?.url || null;
              if (url) {
                const fileRes = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
                const buffer = await fileRes.arrayBuffer();
                const contentType = fileRes.headers.get('content-type') || meta?.mime_type || 'application/octet-stream';
                media[mediaId] = { contentType, base64: Buffer.from(buffer).toString('base64') };
              }
            } catch (e) {
              err(`[ADMIN] ❌ Erro ao baixar mídia ${mediaId}:`, e.message);
            }
          }
        }
      }
      res.json({ success: true, messages, media });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao listar mensagens WhatsApp:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/admin/api/whatsapp/audit/search', requireAuth, async (req, res) => {
    try {
      const auditStore = typeof getAuditStore === 'function' ? getAuditStore() : null;
      if (!auditStore || typeof auditStore.searchWhatsappMessages !== 'function') {
        return res.status(503).json({ success: false, error: 'audit_store_unavailable' });
      }
      const q = String(req.query.q || '').trim();
      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);
      const results = await auditStore.searchWhatsappMessages(q, limit, offset);
      res.json({ success: true, results });
    } catch (error) {
      err(`[ADMIN] ❌ Erro ao buscar mensagens WhatsApp:`, error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}

module.exports = createDashboardRoutes;

