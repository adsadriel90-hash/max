// Função serverless (Vercel) que ativa o cliente no MaxPlayer.
// Fluxo: busca no painel a URL do domínio (MAXPLAYER_DOMAIN_ID) -> valida o login nesse servidor
// Xtream -> confere na Sigma se o revendedor do cliente está na lista permitida -> verifica se já
// existe no MaxPlayer -> cria.

const API = 'https://api.maxplayer.tv/v3/api/public';
const { MAXPLAYER_TOKEN, MAXPLAYER_DOMAIN_ID, MAX_DEVICES, SIGMA_TOKEN } = process.env;
const SIGMA_URL = (process.env.SIGMA_URL || 'https://sistema.ftspanel.vip/api/integration/v1').replace(/\/+$/, '');

// Revendedores autorizados (ID da Sigma ou usuário do revendedor), separados por vírgula.
// Valor "1" = não confere nada (nem login no Xtream, nem Sigma): cria direto no MaxPlayer.
const LIBERAR_TODOS = (process.env.SIGMA_REVENDAS_PERMITIDAS || '').trim() === '1';
const REVENDAS_PERMITIDAS = new Set(
  (process.env.SIGMA_REVENDAS_PERMITIDAS || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean),
);

// Limite simples por IP (por instância). Para tráfego alto, use o Firewall da Vercel ou Upstash.
const tentativas = new Map();
const JANELA_MS = 10 * 60 * 1000;
const MAX_TENTATIVAS = 5;

function bloqueado(ip) {
  const agora = Date.now();
  const lista = (tentativas.get(ip) || []).filter((t) => agora - t < JANELA_MS);
  lista.push(agora);
  tentativas.set(ip, lista);
  return lista.length > MAX_TENTATIVAS;
}

function responder(res, status, ok, mensagem) {
  return res.status(status).json({ ok, mensagem });
}

async function maxplayer(caminho, opcoes = {}) {
  const r = await fetch(API + caminho, {
    ...opcoes,
    headers: {
      'Api-Token': MAXPLAYER_TOKEN,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  let dados = null;
  try { dados = await r.json(); } catch { /* resposta sem JSON */ }
  return { status: r.status, dados };
}

// Endereço do servidor salvo no domínio do painel. Guardado em memória por 10 min
// para não gastar o limite de 60 requisições/min da API.
let cacheServidor = { url: '', ate: 0 };

async function urlDoServidor() {
  if (cacheServidor.url && Date.now() < cacheServidor.ate) return cacheServidor.url;

  // GET /domains/{id} exige chave de provedor; se não der, procura na lista de domínios liberados.
  let d = null;
  const { status, dados } = await maxplayer(`/domains/${encodeURIComponent(MAXPLAYER_DOMAIN_ID)}`);
  if (status === 200 && dados?.data) {
    d = dados.data;
  } else {
    const lista = await maxplayer('/domains');
    if (lista.status === 200 && Array.isArray(lista.dados?.data)) {
      d = lista.dados.data.find((x) => String(x.id) === String(MAXPLAYER_DOMAIN_ID)) || null;
    }
  }
  if (!d?.domain) throw new Error(`domínio ${MAXPLAYER_DOMAIN_ID} não encontrado ou com endereço oculto`);

  const https = Number(d.https) === 1 || d.https === true;
  const porta = d.port ? `:${d.port}` : '';
  const url = `${https ? 'https' : 'http'}://${d.domain}${porta}`;
  cacheServidor = { url, ate: Date.now() + 10 * 60 * 1000 };
  return url;
}

// Confere o login direto no servidor Xtream (player_api.php)
async function validarNoServidor(usuario, senha) {
  let base;
  try {
    base = await urlDoServidor();
  } catch (e) {
    console.error('Não foi possível obter a URL do domínio:', e.message);
    return { ok: false, motivo: 'offline' };
  }
  const url = `${base}/player_api.php?username=${encodeURIComponent(usuario)}&password=${encodeURIComponent(senha)}`;
  let info;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const texto = await r.text();
    try {
      info = JSON.parse(texto)?.user_info;
    } catch {
      console.error('Xtream respondeu sem JSON', r.status, base, texto.slice(0, 120));
      return { ok: false, motivo: 'offline' };
    }
  } catch (e) {
    console.error('Xtream inacessível', base, e.cause?.code || e.name, e.message);
    return { ok: false, motivo: 'offline' };
  }
  if (!info || Number(info.auth) !== 1) return { ok: false, motivo: 'invalido' };
  if (info.status && info.status !== 'Active') return { ok: false, motivo: 'inativo' };
  if (info.exp_date && Number(info.exp_date) * 1000 < Date.now()) return { ok: false, motivo: 'vencido' };
  // Testes (trial) não podem ativar o app
  if (Number(info.is_trial) === 1 || info.is_trial === true) return { ok: false, motivo: 'trial' };
  return { ok: true };
}

// Procura o cliente na Sigma e confere se o revendedor dono dele está na lista permitida
async function revendaPermitida(usuario) {
  let cliente = null;
  for (let pagina = 1; pagina <= 5 && !cliente; pagina++) {
    let r, dados;
    try {
      r = await fetch(`${SIGMA_URL}/customers?username=${encodeURIComponent(usuario)}&page=${pagina}&per_page=20`, {
        headers: { Authorization: `Bearer ${SIGMA_TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      dados = await r.json();
    } catch (e) {
      console.error('Sigma indisponível:', e.message);
      return { ok: false, motivo: 'offline' };
    }
    if (r.status !== 200 || !Array.isArray(dados?.data)) {
      console.error('Sigma recusou a consulta', r.status, dados?.message);
      return { ok: false, motivo: 'offline' };
    }
    // O filtro pode trazer nomes parecidos: só vale o login idêntico e não excluído
    cliente = dados.data.find((c) => c.username === usuario && !c.deleted_at) || null;
    const ultima = dados.pagination?.last_page;
    if (!ultima || pagina >= ultima) break;
  }

  if (!cliente) {
    console.warn('Sigma: cliente não encontrado', usuario);
    return { ok: false, motivo: 'sem_revenda' };
  }
  if (cliente.is_trial === 'YES') return { ok: false, motivo: 'trial' };

  const id = String(cliente.user_id || '').toLowerCase();
  const nome = String(cliente.reseller || '').toLowerCase();
  if (!REVENDAS_PERMITIDAS.has(id) && !REVENDAS_PERMITIDAS.has(nome)) {
    console.warn('Sigma: revendedor fora da lista', usuario, 'revenda', cliente.user_id, cliente.reseller);
    return { ok: false, motivo: 'sem_revenda' };
  }
  return { ok: true, revenda: cliente.reseller, revendaId: cliente.user_id };
}
