/**
 * Rotas do Dashboard
 */

function createDashboardRoutes({ app, requireAuth, dashboardController, logger }) {
  const { log, err } = logger;
  
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
}

module.exports = createDashboardRoutes;

