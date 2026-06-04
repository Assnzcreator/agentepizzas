const fs = require('fs');
try {
  const envContent = fs.readFileSync('.env', 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  });
} catch (e) {
  console.log("Aviso: arquivo .env não encontrado.");
}

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
const { getSystemPrompt } = require('./prompt');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Armazena o histórico das conversas em memória (para produção idealmente num Redis ou BD)
const conversations = {};

// Proteção contra duplicação de webhooks (evita mini-DDoS no banco)
const processedMessages = new Set();
const processingChats = new Map(); // chatId -> Promise (evita processar 2 msgs do mesmo chat em paralelo)
const MAX_PROCESSED_CACHE = 500; // Limpa cache antigo para não consumir memória infinitamente

function markMessageProcessed(messageId) {
  processedMessages.add(messageId);
  // Limpa cache antigo se ficar muito grande
  if (processedMessages.size > MAX_PROCESSED_CACHE) {
    const arr = Array.from(processedMessages);
    for (let i = 0; i < arr.length - 200; i++) {
      processedMessages.delete(arr[i]);
    }
  }
}

let cachedMenu = null;
let lastMenuFetch = 0;

async function getDynamicMenu() {
  const now = Date.now();
  // Cache por 1 minuto para não sobrecarregar o banco
  if (cachedMenu && now - lastMenuFetch < 60000) {
    return cachedMenu;
  }

  const { data: products, error } = await supabase
    .from('products')
    .select('*')
    .eq('available', true)
    .order('category', { ascending: true })
    .order('name', { ascending: true });

  if (error || !products) {
    console.error("Erro ao buscar cardápio:", error);
    return cachedMenu || "Cardápio indisponível no momento.";
  }

  const categorias = {};
  for (const item of products) {
    const cat = (item.category || "outros").toUpperCase();
    if (!categorias[cat]) categorias[cat] = [];
    categorias[cat].push(item);
  }

  const today = new Date().getDay();
  const daysOfWeek = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

  let menuTexto = "";
  for (const [catName, itens] of Object.entries(categorias)) {
    menuTexto += `## ${catName === 'NOVIDADE' ? '🔥 NOVIDADES 🔥' : catName}\n`;
    for (const item of itens) {
      let availabilityInfo = "";
      if (item.available_days && Array.isArray(item.available_days) && item.available_days.length > 0 && item.available_days.length < 7) {
         if (!item.available_days.includes(today)) {
             const daysNames = item.available_days.map(d => daysOfWeek[d]).join(", ");
             availabilityInfo = ` [ATENÇÃO: NÃO disponível hoje. Apenas em: ${daysNames}]`;
         } else {
             const daysNames = item.available_days.map(d => daysOfWeek[d]).join(", ");
             availabilityInfo = ` [Disponível apenas em: ${daysNames}]`;
         }
      }
      menuTexto += `- ${item.name}: ${item.description ? item.description + " " : ""}R$ ${item.price.toFixed(2)}${availabilityInfo}\n`;
    }
    menuTexto += `\n`;
  }

  cachedMenu = menuTexto;
  lastMenuFetch = now;
  return cachedMenu;
}

async function sendWhatsAppMessage(chatId, text) {
  try {
    const limpo = chatId.split('@')[0];
    await axios.post(`${process.env.UAZAPI_URL}/send/text`, {
      number: limpo,
      text: text
    }, {
      headers: {
        'Content-Type': 'application/json',
        'token': process.env.UAZAPI_TOKEN
      }
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem UAZAPI:", error?.response?.data || error.message);
  }
}

async function sendWhatsAppMedia(chatId, base64Data, caption) {
  try {
    const limpo = chatId.split('@')[0];
    await axios.post(`${process.env.UAZAPI_URL}/send/media`, {
      number: limpo,
      type: "image",
      file: base64Data,
      text: caption
    }, {
      headers: {
        'Content-Type': 'application/json',
        'token': process.env.UAZAPI_TOKEN
      }
    });
  } catch (error) {
    console.error("Erro ao enviar mídia UAZAPI:", error?.response?.data || error.message);
  }
}

const toolFinalizarPedido = {
  type: "function",
  function: {
    name: "finalizar_pedido",
    description: "Registra o pedido final no sistema quando todos os dados foram coletados.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nome do cliente" },
        delivery_type: { type: "string", description: "Tipo de entrega: 'DELIVERY' ou 'PICKUP' (Retirada)" },
        delivery_address: { type: "string", description: "Endereço completo de entrega. Vazio se for Retirada." },
        payment_method: { type: "string", description: "Forma de pagamento: 'PIX', 'DINHEIRO', 'CARTAO'" },
        payment_change: { type: "number", description: "Troco para quanto? Retorne 0 se não precisar de troco." },
        total: { type: "number", description: "Valor total do pedido numérico" },
        items: {
          type: "array",
          description: "Lista de pizzas e itens pedidos",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nome completo da pizza ou item (incluindo bordas e sabores)" },
              quantity: { type: "number", description: "Quantidade" },
              unit_price: { type: "number", description: "Preço unitário numérico" }
            },
            required: ["product_name", "quantity", "unit_price"]
          }
        }
      },
      required: ["customer_name", "delivery_type", "payment_method", "total", "items"]
    }
  }
};

const toolEnviarCardapio = {
  type: "function",
  function: {
    name: "enviar_foto_cardapio",
    description: "SÓ chame esta função se o cliente explicitamente pedir a foto/imagem do cardápio. NÃO chame se o cliente perguntar sobre novidades, preços ou lanches específicos.",
    parameters: {
      type: "object",
      properties: {}
    }
  }
};

function formatPhoneNumber(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('55') && (cleaned.length === 12 || cleaned.length === 13)) {
    cleaned = cleaned.substring(2);
  }
  
  if (cleaned.length === 11) {
    return `(${cleaned.substring(0, 2)}) ${cleaned.substring(2, 7)}-${cleaned.substring(7)}`;
  } else if (cleaned.length === 10) {
    return `(${cleaned.substring(0, 2)}) ${cleaned.substring(2, 6)}-${cleaned.substring(6)}`;
  }
  return phone;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Responder rápido pro Webhook não dar timeout
  
  const body = req.body;
  console.log("📩 Webhook recebido:", JSON.stringify(body, null, 2));

  const msgData = body.message || body;
  const chatId = msgData.chatid || msgData.remoteJid || msgData.chatId;
  const fromMe = msgData.fromMe === true;
  const messageId = msgData.messageid || msgData.id || msgData.key?.id;

  let userText = typeof msgData.text === 'string' ? msgData.text : 
                 typeof msgData.content === 'string' ? msgData.content : 
                 typeof msgData.body === 'string' ? msgData.body : "";

  const isMedia = msgData.type === 'media' || msgData.mediaType === 'image' || msgData.mediaType === 'audio' || msgData.mediaType === 'document' || msgData.mediaType === 'video';

  if (!chatId || fromMe || (!userText && !isMedia)) {
    console.log("⚠️ Ignorando mensagem: Sem conteúdo ou é do próprio bot.");
    return;
  }

  // === PROTEÇÃO ANTI-DUPLICAÇÃO ===
  if (messageId && processedMessages.has(messageId)) {
    console.log(`⚠️ Mensagem ${messageId} já processada. Ignorando duplicata.`);
    return;
  }
  if (messageId) markMessageProcessed(messageId);

  // Aguarda se já tem processamento em andamento para este chat
  if (processingChats.has(chatId)) {
    console.log(`⏳ Chat ${chatId} já está processando. Aguardando...`);
    try { await processingChats.get(chatId); } catch (e) { /* ignora erro do anterior */ }
  }

  // Cria uma promise para rastrear o processamento deste chat
  let resolveProcessing;
  const processingPromise = new Promise(r => { resolveProcessing = r; });
  processingChats.set(chatId, processingPromise);

  const now = new Date();
  const currentHour = now.getUTCHours() - 3; // Fuso de Brasília (UTC-3)
  const localHour = currentHour < 0 ? currentHour + 24 : currentHour;

  if (localHour < 18 || localHour >= 22) {
    if (!conversations[chatId] || conversations[chatId].closedAlertSent) {
      await sendWhatsAppMessage(chatId, "Olá! O *Empório das Pizzas* agradece seu contato. 🍕🛵\n\nNo momento estamos fechados. Nosso horário de funcionamento é das *18:00 às 22:00*.\n\nRetorne o contato durante esse horário para fazer o seu pedido!");
      conversations[chatId] = { closedAlertSent: true };
    }
    console.log(`⚠️ Fora do horário comercial (${localHour}h). Alerta enviado para ${chatId}.`);
    return;
  }

  if (conversations[chatId] && conversations[chatId].closedAlertSent) {
    delete conversations[chatId];
  }

  let mediaPart = null;
  if (isMedia) {
    const messageId = msgData.messageid || msgData.id;
    try {
      console.log(`Baixando mídia ${messageId}...`);
      const mediaResponse = await axios.post(`${process.env.UAZAPI_URL}/message/download`, {
        id: messageId,
        return_base64: true,
        return_link: false,
        generate_mp3: true
      }, {
        headers: { 'token': process.env.UAZAPI_TOKEN }
      });

      if (mediaResponse.data && mediaResponse.data.base64Data) {
        mediaPart = {
          data: mediaResponse.data.base64Data,
          mimeType: mediaResponse.data.mimetype || "image/jpeg"
        };
        console.log("✅ Mídia baixada com sucesso!");
      }
    } catch (e) {
      console.error("❌ Erro ao baixar mídia:", e?.response?.data || e.message);
    }
  }

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('COLOQUE_AQUI')) {
    console.log("❌ ERRO: OpenAI API Key não configurada no arquivo .env!");
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const dynamicMenuString = await getDynamicMenu();
  const currentSystemPrompt = getSystemPrompt(dynamicMenuString);

  if (!conversations[chatId]) {
    conversations[chatId] = [
      { role: "system", content: currentSystemPrompt },
      { role: "assistant", content: "Olá! Bem-vindo ao Empório das Pizzas. Como posso ajudar você hoje? 🍕" }
    ];
  } else {
    // Atualiza o prompt de sistema caso o cardápio tenha mudado
    if (conversations[chatId].length > 0 && conversations[chatId][0].role === "system") {
      conversations[chatId][0].content = currentSystemPrompt;
    }
  }
  // Se for áudio, processa a transcrição
  if (mediaPart && mediaPart.mimeType && mediaPart.mimeType.startsWith('audio/')) {
    try {
      const path = require('path');
      const os = require('os');
      const tempFile = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);
      fs.writeFileSync(tempFile, Buffer.from(mediaPart.data, 'base64'));
      
      console.log("🎙️ Transcrevendo áudio com Whisper...");
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempFile),
        model: "whisper-1",
      });
      console.log("✅ Áudio transcrito:", transcription.text);
      userText = `[Áudio transcrito]: ${transcription.text}`;
      
      fs.unlinkSync(tempFile);
      mediaPart = null; // Reseta para não processar como imagem
    } catch (err) {
      console.error("❌ Erro ao transcrever áudio:", err.message || err);
      await sendWhatsAppMessage(chatId, "Desculpe, não consegui entender o áudio. Pode mandar por texto?");
      return;
    }
  }

  let userContent;
  if (mediaPart) {
    userContent = [];
    if (userText) {
      userContent.push({ type: "text", text: userText });
    } else {
      userContent.push({ type: "text", text: "Analise a mídia que acabei de enviar." });
    }
    userContent.push({ type: "image_url", image_url: { url: `data:${mediaPart.mimeType};base64,${mediaPart.data}` } });
  } else {
    userContent = userText || "(Mensagem vazia)";
  }

  conversations[chatId].push({ role: "user", content: userContent });

  try {
    let response;
    try {
      response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: conversations[chatId],
        tools: [toolFinalizarPedido, toolEnviarCardapio]
      });
    } catch (e) {
      if (e.status === 429) {
        console.log("⚠️ Limite de requisições atingido. Aguardando 15 segundos antes de tentar novamente...");
        await sendWhatsAppMessage(chatId, "⏳ Estou processando sua mensagem, só um instante...");
        await new Promise(resolve => setTimeout(resolve, 15000));
        response = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: conversations[chatId],
          tools: [toolFinalizarPedido, toolEnviarCardapio]
        });
      } else {
        throw e;
      }
    }

    const responseMessage = response.choices[0].message;
    const aiMessage = responseMessage.content;
    const toolCalls = responseMessage.tool_calls;

    conversations[chatId].push(responseMessage);

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        if (toolCall.function.name === "enviar_foto_cardapio") {
          console.log("🤖 OpenAI decidiu enviar a foto do cardápio.");
          try {
            const imageBuffer = fs.readFileSync('cardapio.jpg');
            const base64Prefix = "data:image/jpeg;base64," + imageBuffer.toString('base64');
            
            await sendWhatsAppMedia(chatId, base64Prefix, "Aqui está o nosso cardápio! 🍕 Fique à vontade para escolher e me diga o que vai querer.");
            
            conversations[chatId].push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: "Foto do cardápio enviada com sucesso." });
          } catch (err) {
            console.error("❌ Erro ao ler cardapio.jpg:", err.message);
            await sendWhatsAppMessage(chatId, "Desculpe, não consegui carregar a foto do cardápio no momento. Mas temos deliciosas Pizzas! O que deseja?");
            conversations[chatId].push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: "Erro ao enviar cardápio." });
          }
        }
        else if (toolCall.function.name === "finalizar_pedido") {
          const args = JSON.parse(toolCall.function.arguments);
          console.log("🤖 OpenAI fechou o pedido:", args);

          const tipoEntregaConvertido = args.delivery_type === "DELIVERY" ? "WHATSAPP:DELIVERY" : "WHATSAPP:BALCAO";
          
          let finalTotal = args.total;
          const itemsSum = (args.items || []).reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);
          if (args.delivery_type === "DELIVERY" && Math.abs(finalTotal - itemsSum) < 0.01) {
            finalTotal += 5.00;
          }

          const { data: orderData, error: orderError } = await supabase
            .from('orders')
            .insert([{
              customer_name: args.customer_name || "Cliente WhatsApp",
              customer_phone: formatPhoneNumber(chatId),
              delivery_type: tipoEntregaConvertido,
              delivery_address: args.delivery_address || null,
              payment_method: args.payment_method || "DINHEIRO",
              payment_change: args.payment_change || null,
              total: finalTotal,
              status: 'PENDENTE',
              confirmation_code: Math.floor(1000 + Math.random() * 9000).toString()
            }])
            .select()
            .single();

          if (orderError) {
            console.error("Erro ao salvar no Supabase:", orderError);
            await sendWhatsAppMessage(chatId, "Desculpe, tivemos um erro no sistema ao salvar seu pedido. Pode aguardar um momento?");
            conversations[chatId].push({ role: "tool", tool_call_id: toolCall.id, name: toolCall.function.name, content: "Erro ao salvar o pedido." });
          } else {
            if (args.items && args.items.length > 0) {
              const itemsToInsert = args.items.map(item => ({
                order_id: orderData.id,
                product_id: "whatsapp-custom",
                product_name: item.product_name,
                size: "M",
                quantity: item.quantity,
                unit_price: item.unit_price
              }));
              await supabase.from('order_items').insert(itemsToInsert);
            }
            
            await sendWhatsAppMessage(chatId, "✅ *Pedido confirmado e enviado para a cozinha!*\nLogo mais ele estará pronto. Agradecemos a preferência! 🍕🛵");
            
            delete conversations[chatId];
          }
        }
      }
    } else if (aiMessage) {
      await sendWhatsAppMessage(chatId, aiMessage);
    }
  } catch (error) {
    console.error("Erro na OpenAI:", error);
  } finally {
    // Libera o lock do chat para permitir próximas mensagens
    if (resolveProcessing) resolveProcessing();
    processingChats.delete(chatId);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor do Agente rodando na porta ${PORT}`);
});
