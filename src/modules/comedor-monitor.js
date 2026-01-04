/**
 * Módulo Comedor Monitor
 * Processa notificações do ESP32 e envia via WhatsApp usando templates
 */

/**
 * Inicializa o módulo Comedor Monitor
 * @param {Object} config - Configuração do módulo
 * @param {Object} config.whatsapp - Módulo WhatsApp
 * @param {Object} config.logger - Objeto com funções de log
 * @param {Function} config.readNumbersFromFile - Função para ler números autorizados
 * @param {Function} config.normalizeBR - Função para normalizar números BR
 * @param {string} config.numbersFile - Arquivo com números autorizados
 * @param {string} config.messageTemplate - Template de mensagem (opcional)
 * @returns {Object} API do módulo Comedor Monitor
 */
function initComedorMonitorModule({
  whatsapp,
  logger,
  readNumbersFromFile,
  normalizeBR,
  numbersFile,
  messageTemplate
}) {
  const { log, dbg, warn, err } = logger;
  
  // Template padrão para alimentação bem-sucedida
  const DEFAULT_TEMPLATE_SUCCESS = `Acabei de alimentar os seus [TipoAnimal] 🐕!
A [nomeAnimalPoteA] 🐶 recebeu [racaoEntreguePoteA] gramas de ração.
A [nomeAnimalPoteB] 🐈 recebeu [racaoEntreguePoteB] gramas de ração.`;
  
  // Template atual (pode ser configurado via variável de ambiente)
  let currentTemplate = messageTemplate || DEFAULT_TEMPLATE_SUCCESS;
  
  /**
   * Substitui variáveis no template
   * @param {string} template - Template com variáveis [nomeVariavel]
   * @param {Object} variables - Objeto com valores das variáveis
   * @returns {string} Template com variáveis substituídas
   */
  function replaceTemplateVariables(template, variables) {
    let result = template;
    
    // Substituir todas as variáveis no formato [nomeVariavel]
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\[${key}\\]`, 'g');
      result = result.replace(regex, String(value));
    }
    
    return result;
  }
  
  /**
   * Formata data/hora para mensagens
   * @param {number} timestamp - Timestamp Unix (segundos)
   * @returns {Object} Objeto com data, hora e timestamp formatados
   */
  function formatDateTime(timestamp) {
    const date = new Date(timestamp * 1000); // Converter segundos para milissegundos
    const data = date.toLocaleDateString('pt-BR');
    const hora = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return { data, hora, timestamp };
  }
  
  /**
   * Processa notificação do ESP32 e envia via WhatsApp
   * @param {Object} notificationData - Dados da notificação
   * @returns {Promise<Object>} Resultado do processamento
   */
  async function processNotification(notificationData) {
    try {
      const { type } = notificationData;
      
      if (!whatsapp || !whatsapp.isReady || !whatsapp.isReady()) {
        warn(`[COMEDOR] WhatsApp não está pronto - notificação não enviada`);
        return { success: false, error: 'whatsapp_not_ready' };
      }
      
      // Ler números autorizados
      const numbers = readNumbersFromFile(numbersFile || '');
      if (numbers.length === 0) {
        warn(`[COMEDOR] Nenhum número autorizado encontrado`);
        return { success: false, error: 'no_numbers' };
      }
      
      let message = '';
      const dt = formatDateTime(notificationData.timestamp || Math.floor(Date.now() / 1000));
      
      // Processar diferentes tipos de notificações
      switch (type) {
        case 'feeding_success': {
          const variables = {
            TipoAnimal: notificationData.animalType || 'cachorros',
            nomeAnimalPoteA: notificationData.animalAName || 'Animal A',
            racaoEntreguePoteA: notificationData.amountA?.toFixed(1) || '0',
            nomeAnimalPoteB: notificationData.animalBName || 'Animal B',
            racaoEntreguePoteB: notificationData.amountB?.toFixed(1) || '0',
            timestamp: notificationData.timestamp || '',
            data: dt.data,
            hora: dt.hora
          };
          message = replaceTemplateVariables(currentTemplate, variables);
          break;
        }
        
        case 'scale_error': {
          message = `⚠️ Erro na Balança do Comedor
Tipo: Balança não zerada
Descrição: ${notificationData.description || 'Erro desconhecido'}
Peso atual: ${notificationData.currentWeight?.toFixed(2) || 'N/A'}g (tolerância: ${notificationData.tolerance?.toFixed(2) || 'N/A'}g)
Por favor, verifique a balança e tente novamente.`;
          break;
        }
        
        case 'error': {
          message = `⚠️ Erro no Comedor Automático
Tipo: ${notificationData.errorType || 'Erro desconhecido'}
Descrição: ${notificationData.description || 'Sem descrição'}
Hora: ${dt.hora}`;
          break;
        }
        
        case 'low_food': {
          message = `🚨 Alerta: Reservatório de Ração Baixo!
Nível atual: ${notificationData.levelPercent?.toFixed(1) || 'N/A'}%
Por favor, reabasteça o reservatório.`;
          break;
        }
        
        case 'delivery_failure': {
          message = `❌ Falha na Entrega de Ração
Animal: ${notificationData.animalName || 'Desconhecido'}
Motivo: ${notificationData.reason || 'Motivo desconhecido'}
Peso tentado: ${notificationData.attemptedWeight?.toFixed(2) || 'N/A'}g`;
          break;
        }
        
        default: {
          warn(`[COMEDOR] Tipo de notificação desconhecido: ${type}`);
          return { success: false, error: 'unknown_type' };
        }
      }
      
      // Enviar mensagem para todos os números autorizados
      const sendPromises = numbers.map(async (rawPhone) => {
        try {
          const normalized = normalizeBR(rawPhone);
          
          // Resolver número do WhatsApp se necessário
          let to = normalized;
          if (whatsapp.resolveWhatsAppNumber) {
            try {
              const { id: numberId } = await whatsapp.resolveWhatsAppNumber(normalized);
              if (numberId) {
                to = numberId._serialized || numberId || normalized;
              }
            } catch (e) {
              dbg(`[COMEDOR] Erro ao resolver número ${normalized}:`, e.message);
            }
          }
          
          // Remover + do início se presente
          to = to.replace(/^\+/, '');
          
          // Enviar mensagem
          if (whatsapp.sendTextMessage) {
            await whatsapp.sendTextMessage(to, message);
            log(`[COMEDOR] Notificação enviada para ${to}`);
            return { success: true, phone: normalized };
          } else {
            return { success: false, phone: normalized, error: 'send_method_not_available' };
          }
        } catch (e) {
          err(`[COMEDOR] Erro ao enviar notificação para ${rawPhone}:`, e.message);
          return { success: false, phone: rawPhone, error: e.message };
        }
      });
      
      const results = await Promise.all(sendPromises);
      const successCount = results.filter(r => r.success).length;
      
      log(`[COMEDOR] Notificação processada: ${successCount}/${results.length} enviada(s) com sucesso`);
      
      return {
        success: successCount > 0,
        successCount,
        totalCount: results.length,
        type
      };
    } catch (error) {
      err(`[COMEDOR] Erro ao processar notificação:`, error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Atualiza template de mensagem
   * @param {string} template - Novo template
   */
  function setTemplate(template) {
    if (template && typeof template === 'string' && template.trim().length > 0) {
      currentTemplate = template.trim();
      log(`[COMEDOR] Template atualizado`);
      return true;
    }
    return false;
  }
  
  /**
   * Obtém template atual
   * @returns {string} Template atual
   */
  function getTemplate() {
    return currentTemplate;
  }
  
  return {
    processNotification,
    setTemplate,
    getTemplate,
    replaceTemplateVariables
  };
}

module.exports = {
  initComedorMonitorModule
};


